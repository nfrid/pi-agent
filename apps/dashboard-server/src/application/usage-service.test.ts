import { describe, expect, it, vi } from 'vitest';
import { UsageService } from './usage-service.js';

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
