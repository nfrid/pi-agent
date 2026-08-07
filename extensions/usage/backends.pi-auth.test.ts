import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryViaPiAuth } from './backends';

afterEach(() => vi.unstubAllGlobals());

describe('Pi auth cancellation', () => {
  it('filters nullable provider headers before ordinary usage fetch', async () => {
    let requestHeaders: Headers | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestHeaders = new Headers(init?.headers);
        return Response.json({
          rate_limit: { primary_window: { used_percent: 12 } },
        });
      }),
    );
    const ctx = {
      model: { provider: 'openai-codex', id: 'gpt-test' },
      modelRegistry: {
        getAvailable: () => [],
        getAll: () => [],
        getApiKeyAndHeaders: async () => ({
          ok: true,
          headers: {
            Authorization: 'Bearer registry-key',
            'x-delete': null,
          },
        }),
      },
    } as unknown as ExtensionContext;

    await expect(
      queryViaPiAuth(ctx, new AbortController().signal),
    ).resolves.toMatchObject({ snapshots: [{ primary: { usedPercent: 12 } }] });
    expect(requestHeaders?.get('authorization')).toBe('Bearer registry-key');
    expect(requestHeaders?.has('x-delete')).toBe(false);
  });

  it('stops waiting for unresolved credential lookup when aborted', async () => {
    let rejectAuth!: (error: Error) => void;
    const auth = new Promise<never>((_resolve, reject) => {
      rejectAuth = reject;
    });
    const model = { provider: 'openai-codex', id: 'gpt-test' };
    const ctx = {
      model,
      modelRegistry: {
        getAvailable: () => [],
        getAll: () => [],
        getApiKeyAndHeaders: () => auth,
      },
    } as unknown as ExtensionContext;
    const controller = new AbortController();
    const pending = queryViaPiAuth(ctx, controller.signal);
    const cancellation = new Error('cancelled auth lookup');
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    // The abandoned resolver remains observed and may reject later without
    // becoming an unhandled rejection.
    rejectAuth(new Error('late auth failure'));
    await Promise.resolve();
  });
});
