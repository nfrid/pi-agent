import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../utils';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('transient retry', () => {
  it('retries transient responses, honors bounded Retry-After, and succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('busy', { status: 429, headers: { 'Retry-After': '30' } }),
      )
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchWithRetry(
      'https://example.com',
      {},
      { maxDelayMs: 20 },
    );
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry deterministic 4xx responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('bad', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchWithRetry('https://example.com')).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('aborts during backoff without another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchWithRetry(
      'https://example.com',
      { signal: controller.signal },
      { baseDelayMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
