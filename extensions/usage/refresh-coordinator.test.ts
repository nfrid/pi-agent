import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefreshCoordinator } from './refresh-coordinator';

interface TestContext {
  id: string;
  enabled: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(
  isFresh: (report: string, ctx: TestContext) => boolean = () => false,
) {
  const queries: Array<{
    ctx: TestContext;
    signal: AbortSignal;
    result: Deferred<string>;
  }> = [];
  const reports: string[] = [];
  const errors: string[] = [];
  const clears: string[] = [];
  const loading: string[] = [];
  const coordinator = new RefreshCoordinator<TestContext, string>({
    debounceMs: 20,
    query: (ctx, signal) => {
      const result = deferred<string>();
      queries.push({ ctx, signal, result });
      return result.promise;
    },
    canRefresh: (ctx) => ctx.enabled,
    isFresh,
    onLoading: (ctx) => loading.push(ctx.id),
    onReport: (report, ctx) => reports.push(`${ctx.id}:${report}`),
    onError: (ctx) => errors.push(ctx.id),
    onClear: (ctx) => clears.push(ctx.id),
  });
  return { coordinator, queries, reports, errors, clears, loading };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RefreshCoordinator', () => {
  it('coalesces duplicate settled notifications into one query', async () => {
    vi.useFakeTimers();
    const h = harness();
    const ctx = { id: 'session', enabled: true };
    const started = h.coordinator.sessionStart(ctx);
    h.queries[0]?.result.resolve('initial');
    await started;

    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(10);
    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(19);
    expect(h.queries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.queries).toHaveLength(2);

    h.queries[1]?.result.resolve('settled');
    await flush();
    expect(h.reports).toEqual(['session:initial', 'session:settled']);
  });

  it('retains one settled refresh behind an in-flight query', async () => {
    vi.useFakeTimers();
    const h = harness();
    const ctx = { id: 'session', enabled: true };
    void h.coordinator.sessionStart(ctx);

    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.queries).toHaveLength(1);

    h.queries[0]?.result.resolve('initial');
    await flush();
    expect(h.queries).toHaveLength(2);

    h.queries[1]?.result.resolve('settled');
    await flush();
    expect(h.reports).toEqual(['session:initial', 'session:settled']);
  });

  it('coalesces repeated settled requests into one trailing query', async () => {
    vi.useFakeTimers();
    const h = harness();
    const ctx = { id: 'session', enabled: true };
    void h.coordinator.sessionStart(ctx);

    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(20);
    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.queries).toHaveLength(1);

    h.queries[0]?.result.resolve('initial');
    await flush();
    expect(h.queries).toHaveLength(2);
    h.queries[1]?.result.resolve('settled');
    await flush();
    expect(h.reports).toEqual(['session:initial', 'session:settled']);
  });

  it('runs one trailing forced query and lets manual refresh await it', async () => {
    const h = harness();
    const ctx = { id: 'session', enabled: true };
    void h.coordinator.sessionStart(ctx);

    let manualDone = false;
    const manual = h.coordinator.manual(ctx).then(() => {
      manualDone = true;
    });
    const secondManual = h.coordinator.manual(ctx);
    expect(h.queries).toHaveLength(1);

    h.queries[0]?.result.resolve('old');
    await flush();
    expect(h.queries).toHaveLength(2);
    expect(manualDone).toBe(false);

    h.queries[1]?.result.resolve('forced');
    await Promise.all([manual, secondManual]);
    expect(manualDone).toBe(true);
    expect(h.queries).toHaveLength(2);
    expect(h.reports).toEqual(['session:old', 'session:forced']);
  });

  it('ignores stale completion and refreshes the new model generation', async () => {
    const h = harness();
    const oldModel = { id: 'old', enabled: true };
    const newModel = { id: 'new', enabled: true };
    void h.coordinator.sessionStart(oldModel);
    const changed = h.coordinator.modelChanged(newModel);

    h.queries[0]?.result.resolve('stale');
    await flush();
    expect(h.reports).toEqual([]);
    expect(h.queries).toHaveLength(2);

    h.queries[1]?.result.resolve('current');
    await changed;
    expect(h.reports).toEqual(['new:current']);
  });

  it('does not reuse a prior-model cache after generation advance', async () => {
    const h = harness(() => true);
    const oldModel = { id: 'old', enabled: true };
    const newModel = { id: 'new', enabled: true };
    const started = h.coordinator.sessionStart(oldModel);
    h.queries[0]?.result.resolve('cached');
    await started;

    const changed = h.coordinator.modelChanged(newModel);
    await h.coordinator.periodic(newModel);
    expect(h.queries).toHaveLength(2);
    expect(h.reports).toEqual(['old:cached']);

    h.queries[1]?.result.resolve('current');
    await changed;
    expect(h.reports).toEqual(['old:cached', 'new:current']);
  });

  it('does not reuse a prior-session cache after restart', async () => {
    const h = harness(() => true);
    const oldSession = { id: 'old', enabled: true };
    const newSession = { id: 'new', enabled: true };
    const first = h.coordinator.sessionStart(oldSession);
    h.queries[0]?.result.resolve('cached');
    await first;
    h.coordinator.sessionShutdown(oldSession);

    const restarted = h.coordinator.sessionStart(newSession);
    await h.coordinator.periodic(newSession);
    expect(h.queries).toHaveLength(2);
    expect(h.reports).toEqual(['old:cached']);

    h.queries[1]?.result.resolve('current');
    await restarted;
    expect(h.reports).toEqual(['old:cached', 'new:current']);
  });

  it('recovers after a failed query and can refresh again', async () => {
    const h = harness();
    const ctx = { id: 'session', enabled: true };
    const started = h.coordinator.sessionStart(ctx);
    h.queries[0]?.result.reject(new Error('network'));
    await started;
    expect(h.errors).toEqual(['session']);

    const retry = h.coordinator.manual(ctx);
    expect(h.queries).toHaveLength(2);
    h.queries[1]?.result.resolve('recovered');
    await retry;
    expect(h.reports).toEqual(['session:recovered']);
  });

  it('resolves queued waiters and serializes restart behind cancelled work', async () => {
    const h = harness();
    const oldSession = { id: 'old', enabled: true };
    const newSession = { id: 'new', enabled: true };
    void h.coordinator.sessionStart(oldSession);
    let manualDone = false;
    const manual = h.coordinator.manual(oldSession).then(() => {
      manualDone = true;
    });

    h.coordinator.sessionShutdown(oldSession);
    await manual;
    expect(manualDone).toBe(true);
    expect(h.queries[0]?.signal.aborted).toBe(true);

    const restarted = h.coordinator.sessionStart(newSession);
    expect(h.queries).toHaveLength(1);
    h.queries[0]?.result.resolve('stale');
    await flush();
    expect(h.reports).toEqual([]);
    expect(h.queries).toHaveLength(2);

    h.queries[1]?.result.resolve('current');
    await restarted;
    expect(h.reports).toEqual(['new:current']);
  });

  it('cancels settled work and suppresses in-flight completion on shutdown', async () => {
    vi.useFakeTimers();
    const h = harness();
    const ctx = { id: 'session', enabled: true };
    void h.coordinator.sessionStart(ctx);
    h.coordinator.settled(ctx);
    h.coordinator.sessionShutdown(ctx);

    expect(h.queries[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.queries).toHaveLength(1);
    expect(h.clears).toEqual(['session']);

    h.queries[0]?.result.resolve('late');
    await flush();
    expect(h.reports).toEqual([]);
    await h.coordinator.manual(ctx);
    expect(h.queries).toHaveLength(1);
  });
});
