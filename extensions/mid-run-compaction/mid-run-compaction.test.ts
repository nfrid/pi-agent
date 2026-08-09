import type {
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test, vi } from 'vitest';
import { hasPendingProcesses } from '../shared/runtime/pending-processes';
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
    expect(hasPendingProcesses()).toBe(true);

    onComplete?.();
    expect(hasPendingProcesses()).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'mid-run-compaction',
        display: false,
      }),
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  });

  test('isolates replacement work from stale lifecycle and duplicate callbacks', () => {
    let turnEndHandler:
      | ((event: TurnEndEvent, ctx: ExtensionContext) => void)
      | undefined;
    type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => void;
    let shutdownHandler: LifecycleHandler | undefined;
    let startHandler: LifecycleHandler | undefined;
    const sendMessage = vi.fn();
    const api = {
      on: vi.fn((name: string, handler: unknown) => {
        if (name === 'turn_end')
          turnEndHandler = handler as typeof turnEndHandler;
        if (name === 'session_start')
          startHandler = handler as LifecycleHandler;
        if (name === 'session_shutdown')
          shutdownHandler = handler as LifecycleHandler;
      }),
      sendMessage,
    } as unknown as ExtensionAPI;
    midRunCompaction(api);

    let oldOnError: ((error: Error) => void) | undefined;
    let stale = false;
    const oldContext = {
      ...context(180_000),
      sessionManager: {},
      compact: vi.fn(
        (options: { onError?: (error: Error) => void }) =>
          (oldOnError = options.onError),
      ),
      ui: {
        setStatus: vi.fn(() => {
          if (stale) throw new Error('stale context');
        }),
        notify: vi.fn(() => {
          if (stale) throw new Error('stale context');
        }),
      },
    } as unknown as ExtensionContext;

    turnEndHandler?.(turnEnd(1), oldContext);
    expect(hasPendingProcesses()).toBe(true);
    shutdownHandler?.({}, oldContext);
    expect(hasPendingProcesses()).toBe(false);

    let newOnComplete: (() => void) | undefined;
    const newContext = {
      ...context(180_000),
      sessionManager: {},
      compact: vi.fn(
        (options: { onComplete?: () => void }) =>
          (newOnComplete = options.onComplete),
      ),
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    startHandler?.({}, newContext);
    turnEndHandler?.(turnEnd(1), newContext);
    expect(hasPendingProcesses()).toBe(true);

    stale = true;
    shutdownHandler?.({}, oldContext);
    expect(hasPendingProcesses()).toBe(true);
    expect(() => oldOnError?.(new Error('late failure'))).not.toThrow();
    expect(hasPendingProcesses()).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();

    newOnComplete?.();
    newOnComplete?.();
    expect(hasPendingProcesses()).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test('cleans pending accounting when compaction setup throws', () => {
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

    const ctx = {
      ...context(180_000),
      compact: vi.fn(() => {
        throw new Error('setup failed');
      }),
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    expect(() => turnEndHandler?.(turnEnd(1), ctx)).not.toThrow();
    expect(hasPendingProcesses()).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('setup failed'),
      'warning',
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
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
    expect(hasPendingProcesses()).toBe(true);
    onError?.(new Error('no summary'));
    expect(hasPendingProcesses()).toBe(false);
    turnEndHandler?.(turnEnd(1), ctx);

    expect(compact).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('no summary'),
      'warning',
    );
  });
});
