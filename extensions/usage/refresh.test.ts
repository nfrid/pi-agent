import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUsageRefresh } from './refresh';
import type { UsageReport } from './types';

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

function context(id: string, enabled = true): ExtensionContext {
  return { id, hasUI: enabled } as unknown as ExtensionContext;
}

function report(label: string): UsageReport {
  return { capturedAt: Date.now(), snapshots: [{ limitId: label }] };
}

function harness(isFresh: (report: UsageReport) => boolean = () => false) {
  const queries: Array<{
    ctx: ExtensionContext;
    signal: AbortSignal;
    result: Deferred<UsageReport>;
  }> = [];
  const reports: string[] = [];
  const errors: string[] = [];
  const clears: string[] = [];
  const loading: string[] = [];
  const coordinator = createUsageRefresh({
    debounceMs: 20,
    query: (ctx, signal) => {
      const result = deferred<UsageReport>();
      queries.push({ ctx, signal, result });
      return result.promise;
    },
    canRefresh: (ctx) => Boolean((ctx as { hasUI?: boolean }).hasUI),
    isFresh,
    onLoading: (ctx) => loading.push(String((ctx as { id?: string }).id)),
    onReport: (value, ctx) =>
      reports.push(
        `${String((ctx as { id?: string }).id)}:${value.snapshots[0]?.limitId}`,
      ),
    onError: (ctx) => errors.push(String((ctx as { id?: string }).id)),
    onClear: (ctx) => clears.push(String((ctx as { id?: string }).id)),
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

describe('UsageRefresh', () => {
  it('coalesces duplicate settled notifications into one query', async () => {
    vi.useFakeTimers();
    const h = harness();
    const ctx = context('session');
    const started = h.coordinator.sessionStart(ctx);
    h.queries[0]?.result.resolve(report('initial'));
    await started;

    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(10);
    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(19);
    expect(h.queries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.queries).toHaveLength(2);

    h.queries[1]?.result.resolve(report('settled'));
    await flush();
    expect(h.reports).toEqual(['session:initial', 'session:settled']);
  });

  it('retains one settled refresh behind an in-flight query', async () => {
    vi.useFakeTimers();
    const h = harness();
    const ctx = context('session');
    void h.coordinator.sessionStart(ctx);

    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.queries).toHaveLength(1);

    h.queries[0]?.result.resolve(report('initial'));
    await flush();
    expect(h.queries).toHaveLength(2);

    h.queries[1]?.result.resolve(report('settled'));
    await flush();
    expect(h.reports).toEqual(['session:initial', 'session:settled']);
  });

  it('coalesces repeated settled requests into one trailing query', async () => {
    vi.useFakeTimers();
    const h = harness();
    const ctx = context('session');
    void h.coordinator.sessionStart(ctx);

    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(20);
    h.coordinator.settled(ctx);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.queries).toHaveLength(1);

    h.queries[0]?.result.resolve(report('initial'));
    await flush();
    expect(h.queries).toHaveLength(2);
    h.queries[1]?.result.resolve(report('settled'));
    await flush();
    expect(h.reports).toEqual(['session:initial', 'session:settled']);
  });

  it('runs one trailing forced query and lets manual refresh await it', async () => {
    const h = harness();
    const ctx = context('session');
    void h.coordinator.sessionStart(ctx);

    let manualDone = false;
    const manual = h.coordinator.manual(ctx).then(() => {
      manualDone = true;
    });
    const secondManual = h.coordinator.manual(ctx);
    expect(h.queries).toHaveLength(1);

    h.queries[0]?.result.resolve(report('old'));
    await flush();
    expect(h.queries).toHaveLength(2);
    expect(manualDone).toBe(false);

    h.queries[1]?.result.resolve(report('forced'));
    await Promise.all([manual, secondManual]);
    expect(manualDone).toBe(true);
    expect(h.queries).toHaveLength(2);
    expect(h.reports).toEqual(['session:old', 'session:forced']);
  });

  it('ignores stale completion and refreshes the new model generation', async () => {
    const h = harness();
    const oldModel = context('old');
    const newModel = context('new');
    void h.coordinator.sessionStart(oldModel);
    const changed = h.coordinator.modelChanged(newModel);

    h.queries[0]?.result.resolve(report('stale'));
    await flush();
    expect(h.reports).toEqual([]);
    expect(h.queries).toHaveLength(2);

    h.queries[1]?.result.resolve(report('current'));
    await changed;
    expect(h.reports).toEqual(['new:current']);
  });

  it('does not reuse a prior-model cache after generation advance', async () => {
    const h = harness(() => true);
    const oldModel = context('old');
    const newModel = context('new');
    const started = h.coordinator.sessionStart(oldModel);
    h.queries[0]?.result.resolve(report('cached'));
    await started;

    const changed = h.coordinator.modelChanged(newModel);
    await h.coordinator.periodic(newModel);
    expect(h.queries).toHaveLength(2);
    expect(h.reports).toEqual(['old:cached']);

    h.queries[1]?.result.resolve(report('current'));
    await changed;
    expect(h.reports).toEqual(['old:cached', 'new:current']);
  });

  it('does not reuse a prior-session cache after restart', async () => {
    const h = harness(() => true);
    const oldSession = context('old');
    const newSession = context('new');
    const first = h.coordinator.sessionStart(oldSession);
    h.queries[0]?.result.resolve(report('cached'));
    await first;
    h.coordinator.sessionShutdown(oldSession);

    const restarted = h.coordinator.sessionStart(newSession);
    await h.coordinator.periodic(newSession);
    expect(h.queries).toHaveLength(2);
    expect(h.reports).toEqual(['old:cached']);

    h.queries[1]?.result.resolve(report('current'));
    await restarted;
    expect(h.reports).toEqual(['old:cached', 'new:current']);
  });

  it('recovers after a failed query and can refresh again', async () => {
    const h = harness();
    const ctx = context('session');
    const started = h.coordinator.sessionStart(ctx);
    h.queries[0]?.result.reject(new Error('network'));
    await started;
    expect(h.errors).toEqual(['session']);

    const retry = h.coordinator.manual(ctx);
    expect(h.queries).toHaveLength(2);
    h.queries[1]?.result.resolve(report('recovered'));
    await retry;
    expect(h.reports).toEqual(['session:recovered']);
  });

  it('resolves queued waiters and serializes restart behind cancelled work', async () => {
    const h = harness();
    const oldSession = context('old');
    const newSession = context('new');
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
    h.queries[0]?.result.resolve(report('stale'));
    await flush();
    expect(h.reports).toEqual([]);
    expect(h.queries).toHaveLength(2);

    h.queries[1]?.result.resolve(report('current'));
    await restarted;
    expect(h.reports).toEqual(['new:current']);
  });

  it('cancels settled work and suppresses in-flight completion on shutdown', async () => {
    vi.useFakeTimers();
    const h = harness();
    const ctx = context('session');
    void h.coordinator.sessionStart(ctx);
    h.coordinator.settled(ctx);
    h.coordinator.sessionShutdown(ctx);

    expect(h.queries[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.queries).toHaveLength(1);
    expect(h.clears).toEqual(['session']);

    h.queries[0]?.result.resolve(report('late'));
    await flush();
    expect(h.reports).toEqual([]);
    await h.coordinator.manual(ctx);
    expect(h.queries).toHaveLength(1);
  });
});
