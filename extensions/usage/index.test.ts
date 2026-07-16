import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTLED_REFRESH_DEBOUNCE_MS } from './constants';
import { registerUsage } from './index';
import type { UsageReport } from './types';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function context(): ExtensionContext {
  return {
    hasUI: true,
    model: {
      provider: 'openai-codex',
      id: 'codex-test',
      name: 'Codex Test',
    },
    ui: {
      setStatus: vi.fn(),
      theme: {
        fg: (_color: unknown, text: string) => text,
        italic: (text: string) => text,
      },
    },
  } as unknown as ExtensionContext;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('usage lifecycle wiring', () => {
  it('waits through multi-turn/retry-like events and queries once after agent_settled', async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, Handler>();
    const on = vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    });
    const pi = {
      on,
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;
    const pending: Array<ReturnType<typeof deferred<UsageReport>>> = [];
    const query = vi.fn(() => {
      const result = deferred<UsageReport>();
      pending.push(result);
      return result.promise;
    });
    const ctx = context();
    registerUsage(pi, query);

    handlers.get('session_start')?.({}, ctx);
    expect(query).toHaveBeenCalledTimes(1);
    pending[0]?.resolve({ capturedAt: Date.now(), snapshots: [] });
    await Promise.resolve();
    await Promise.resolve();

    // These model multiple turns, a retry, and an agent_end before the run is
    // truly idle. None are refresh triggers in Pi 0.80.7.
    handlers.get('turn_end')?.({}, ctx);
    handlers.get('turn_end')?.({}, ctx);
    handlers.get('agent_end')?.({}, ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(query).toHaveBeenCalledTimes(1);
    expect(handlers.has('turn_end')).toBe(false);
    expect(handlers.has('agent_end')).toBe(false);

    handlers.get('agent_settled')?.({}, ctx);
    await vi.advanceTimersByTimeAsync(SETTLED_REFRESH_DEBOUNCE_MS - 1);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);

    pending[1]?.resolve({ capturedAt: Date.now(), snapshots: [] });
    await vi.advanceTimersByTimeAsync(SETTLED_REFRESH_DEBOUNCE_MS * 2);
    expect(query).toHaveBeenCalledTimes(2);
    handlers.get('session_shutdown')?.({}, ctx);
  });
});
