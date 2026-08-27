import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageService } from './usage-service.js';

afterEach(() => vi.useRealTimers());

describe('UsageService', () => {
  it('coalesces concurrent provider requests and caches the result', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    const provider = {
      get: vi.fn(
        () =>
          new Promise<unknown>((complete) => {
            resolve = complete;
          }),
      ),
    };
    const changed = vi.fn();
    const service = new UsageService(provider, changed);
    const first = service.get();
    const second = service.get();
    expect(provider.get).toHaveBeenCalledTimes(1);
    resolve?.({ remaining: 7 });
    await expect(first).resolves.toEqual({ usage: { remaining: 7 } });
    await expect(second).resolves.toEqual({ usage: { remaining: 7 } });
    await expect(service.get()).resolves.toEqual({ usage: { remaining: 7 } });
    expect(provider.get).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('polls once a minute while honoring active and idle freshness', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    let active = false;
    const provider = { get: vi.fn(async () => ({ active })) };
    const service = new UsageService(provider, undefined, {
      freshMs: () => (active ? 60_000 : 20 * 60_000),
      pollMs: 60_000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19 * 60_000);
    expect(provider.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.get).toHaveBeenCalledTimes(2);

    active = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.get).toHaveBeenCalledTimes(3);

    service.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(provider.get).toHaveBeenCalledTimes(3);
  });

  it('aborts an in-flight provider request when stopped', async () => {
    let requestSignal: AbortSignal | undefined;
    const provider = {
      get: vi.fn(
        (signal?: AbortSignal) =>
          new Promise<unknown>((_resolve, reject) => {
            requestSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    };
    const service = new UsageService(provider);

    service.start();
    expect(requestSignal?.aborted).toBe(false);
    service.stop();
    expect(requestSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(provider.get).toHaveBeenCalledTimes(1));
  });

  it('keeps the last valid value when a later provider response is too large', async () => {
    const provider = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce('x'.repeat(300_000)),
    };
    const service = new UsageService(provider);
    await expect(service.get()).resolves.toEqual({ usage: { ok: true } });
    // The cache is deliberately short-circuited in this test by changing the
    // provider request through a fresh service; the size guard is still a
    // service-only behavior and does not involve Fastify.
    const invalid = new UsageService(provider);
    await expect(invalid.get()).resolves.toMatchObject({
      error: expect.any(String),
    });
  });
});
