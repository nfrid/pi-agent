import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from './http';

afterEach(() => vi.unstubAllGlobals());

describe('usage HTTP cancellation', () => {
  it('forwards caller cancellation to the physical fetch', async () => {
    let received: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        received = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          received?.addEventListener(
            'abort',
            () => reject(received?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      }),
    );
    const controller = new AbortController();
    const request = fetchWithTimeout('https://example.test', {
      signal: controller.signal,
    });

    controller.abort(new Error('session shutdown'));
    await expect(request).rejects.toThrow('session shutdown');
    expect(received?.aborted).toBe(true);
  });
});
