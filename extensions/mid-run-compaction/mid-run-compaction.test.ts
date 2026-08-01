import type {
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test, vi } from 'vitest';
import midRunCompaction, { shouldCompactMidRun } from './index';

function context(tokens: number | null, contextWindow = 200_000) {
  return {
    getContextUsage: () => ({
      tokens,
      contextWindow,
      percent: tokens === null ? null : (tokens / contextWindow) * 100,
    }),
  } as ExtensionContext;
}

function turnEnd(toolResultCount: number): TurnEndEvent {
  return {
    type: 'turn_end',
    turnIndex: 0,
    message: {} as TurnEndEvent['message'],
    toolResults: Array.from(
      { length: toolResultCount },
      () => ({}) as TurnEndEvent['toolResults'][number],
    ),
  };
}

describe('mid-run compaction', () => {
  test('uses conservative dynamic headroom only during tool loops', () => {
    expect(shouldCompactMidRun(turnEnd(1), context(167_231))).toBe(false);
    expect(shouldCompactMidRun(turnEnd(1), context(167_233))).toBe(true);
    expect(shouldCompactMidRun(turnEnd(0), context(190_000))).toBe(false);
    expect(shouldCompactMidRun(turnEnd(1), context(null))).toBe(false);

    expect(shouldCompactMidRun(turnEnd(1), context(95_231, 128_000))).toBe(
      false,
    );
    expect(shouldCompactMidRun(turnEnd(1), context(95_233, 128_000))).toBe(
      true,
    );
  });

  test('compacts once and resumes through a hidden custom message', () => {
    let turnEndHandler:
      | ((event: TurnEndEvent, ctx: ExtensionContext) => void)
      | undefined;
    const sendMessage = vi.fn();
    const api = {
      on: vi.fn((name: string, handler: typeof turnEndHandler) => {
        if (name === 'turn_end') turnEndHandler = handler;
      }),
      sendMessage,
    } as unknown as ExtensionAPI;
    midRunCompaction(api);

    let onComplete: (() => void) | undefined;
    const compact = vi.fn(
      (options: { onComplete?: () => void }) =>
        (onComplete = options.onComplete),
    );
    const ctx = {
      ...context(180_000),
      compact,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    turnEndHandler?.(turnEnd(1), ctx);
    turnEndHandler?.(turnEnd(1), ctx);
    expect(compact).toHaveBeenCalledTimes(1);

    onComplete?.();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'mid-run-compaction',
        display: false,
      }),
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  });

  test('resumes but disables further attempts after compaction fails', () => {
    let turnEndHandler:
      | ((event: TurnEndEvent, ctx: ExtensionContext) => void)
      | undefined;
    const sendMessage = vi.fn();
    const api = {
      on: vi.fn((name: string, handler: typeof turnEndHandler) => {
        if (name === 'turn_end') turnEndHandler = handler;
      }),
      sendMessage,
    } as unknown as ExtensionAPI;
    midRunCompaction(api);

    let onError: ((error: Error) => void) | undefined;
    const compact = vi.fn(
      (options: { onError?: (error: Error) => void }) =>
        (onError = options.onError),
    );
    const notify = vi.fn();
    const ctx = {
      ...context(180_000),
      compact,
      ui: { setStatus: vi.fn(), notify },
    } as unknown as ExtensionContext;

    turnEndHandler?.(turnEnd(1), ctx);
    onError?.(new Error('no summary'));
    turnEndHandler?.(turnEnd(1), ctx);

    expect(compact).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('no summary'),
      'warning',
    );
  });
});
