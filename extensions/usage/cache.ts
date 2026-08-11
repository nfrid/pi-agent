import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { UsageReport } from './types';

/**
 * Usage responses are account/provider state, not session state. Keep the
 * cache on a well-known global so Pi's extension reloads and replacement
 * sessions can share it without sharing a session's UI or model selection.
 */
const CACHE_SYMBOL = Symbol.for('pi.usage.process-cache');

type UsageQuery = (
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<UsageReport>;

interface SharedUsageState {
  reports: Map<string, UsageReport>;
  inFlight: Map<string, Promise<UsageReport>>;
  queryIds: WeakMap<UsageQuery, number>;
  nextQueryId: number;
}

function getState(): SharedUsageState {
  const host = globalThis as typeof globalThis & {
    [CACHE_SYMBOL]?: SharedUsageState;
  };
  const existing = host[CACHE_SYMBOL];
  if (existing) return existing;
  const state: SharedUsageState = {
    reports: new Map(),
    inFlight: new Map(),
    queryIds: new WeakMap(),
    nextQueryId: 0,
  };
  host[CACHE_SYMBOL] = state;
  return state;
}

function queryNamespace(query: UsageQuery, stable: boolean): string {
  if (stable) return 'default';
  const state = getState();
  let id = state.queryIds.get(query);
  if (id === undefined) {
    id = ++state.nextQueryId;
    state.queryIds.set(query, id);
  }
  return `query-${id}`;
}

function providerKey(ctx: ExtensionContext): string | undefined {
  const provider = ctx.model?.provider?.trim();
  return provider ? provider : undefined;
}

function waitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', abort),
    );
  });
}

export interface SharedUsageQueryOptions {
  /** Bypass a fresh process cache entry, but still coalesce in-flight work. */
  force?: boolean;
}

/**
 * Wrap a provider query with process-level freshness and request coalescing.
 * The physical request has its own controller: one session shutting down must
 * not cancel a request another live session is waiting to reuse.
 */
export function createSharedUsageQuery(
  query: UsageQuery,
  options: { freshMs: number; stable?: boolean },
): (
  ctx: ExtensionContext,
  signal: AbortSignal,
  queryOptions?: SharedUsageQueryOptions,
) => Promise<UsageReport> {
  const namespace = queryNamespace(query, options.stable === true);

  return async (ctx, signal, queryOptions = {}) => {
    const provider = providerKey(ctx);
    if (!provider) return query(ctx, signal);
    const key = `${namespace}\u0000${provider}`;
    const state = getState();
    const cached = state.reports.get(key);
    if (
      !queryOptions.force &&
      cached &&
      Date.now() - cached.capturedAt < options.freshMs
    )
      return cached;

    let pending = state.inFlight.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = query(ctx, controller.signal)
        .then((report) => {
          const withProvider = report.provider
            ? report
            : { ...report, provider };
          state.reports.set(key, withProvider);
          return withProvider;
        })
        .finally(() => {
          if (state.inFlight.get(key) === pending) state.inFlight.delete(key);
        });
      state.inFlight.set(key, pending);
    }
    return waitWithAbort(pending, signal);
  };
}

/** Test/support reset; production sessions intentionally leave this state live. */
export function resetSharedUsageState(): void {
  const host = globalThis as typeof globalThis & {
    [CACHE_SYMBOL]?: SharedUsageState;
  };
  const state = host[CACHE_SYMBOL];
  state?.reports.clear();
  state?.inFlight.clear();
}
