import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { queryViaPiAuth } from './backends';

describe('Pi auth cancellation', () => {
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
