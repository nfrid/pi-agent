import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { cancelActiveCompaction } from './compaction-control';
import { compactWithDashboardCancellation } from './compaction-shim';

const event = (signal = new AbortController().signal) =>
  ({
    type: 'session_before_compact',
    preparation: { settings: {} },
    branchEntries: [],
    reason: 'manual',
    willRetry: false,
    signal,
  }) as unknown as SessionBeforeCompactEvent;

const context = {
  model: { provider: 'test', id: 'model' },
  thinkingLevel: 'off',
  modelRegistry: {
    getApiKeyAndHeaders: vi.fn(async () => ({
      ok: true,
      apiKey: 'key',
      headers: { test: 'header' },
      env: { TEST: '1' },
    })),
  },
} as unknown as ExtensionContext;

describe('extension-owned compaction shim', () => {
  it('returns Pi-compatible compaction output', async () => {
    const result = {
      summary: 'summary',
      firstKeptEntryId: 'kept',
      tokensBefore: 1,
    };
    const compact = vi.fn(async () => result);

    await expect(
      compactWithDashboardCancellation(event(), context, compact as never),
    ).resolves.toEqual({ compaction: result });
    expect(compact).toHaveBeenCalledWith(
      expect.anything(),
      context.model,
      'key',
      { test: 'header' },
      undefined,
      expect.any(AbortSignal),
      'off',
      undefined,
      { TEST: '1' },
    );
  });

  it('turns dashboard cancellation into a cancelled before-event', async () => {
    const compact = vi.fn(
      async (...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          const signal = args[5] as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const pending = compactWithDashboardCancellation(
      event(),
      context,
      compact as never,
    );
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());

    cancelActiveCompaction();

    await expect(pending).resolves.toEqual({ cancel: true });
  });
});
