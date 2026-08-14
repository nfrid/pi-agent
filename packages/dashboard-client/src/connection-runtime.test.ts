import type {
  AuthoritativeSessionSnapshot,
  BrowserSnapshot,
} from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { DashboardConnectionRuntime } from './connection-runtime.js';
import { DashboardLiveStore } from './store.js';

const shellSnapshot = (cursor: number): BrowserSnapshot =>
  ({
    serverId: 'daemon-1',
    revision: cursor,
    cursor,
    runtimes: [],
    workspaces: [],
    sessions: [],
    unread: [],
  }) as BrowserSnapshot;

const sessionSnapshot = (
  cursor: number,
  id = 'session-a',
): AuthoritativeSessionSnapshot =>
  ({
    serverId: 'daemon-1',
    cursor,
    metadata: { id, file: '', cwd: '/tmp', updatedAt: cursor },
    entries: [],
  }) as unknown as AuthoritativeSessionSnapshot;

type Observer = {
  onData: (value: unknown) => void;
  onError?: (error: unknown) => void;
};

function fixture() {
  let shellObserver: Observer | undefined;
  const sessionObservers = new Map<string, Observer>();
  let shellSubscriptions = 0;
  let sessionSubscriptions = 0;
  const client = {
    getTrpcClient: async () => ({
      shellSubscribe: {
        subscribe: (_input: unknown, observer: Observer) => {
          shellSubscriptions += 1;
          shellObserver = observer;
          return {
            unsubscribe: () => {
              if (shellObserver === observer) shellObserver = undefined;
            },
          };
        },
      },
      sessionSubscribe: {
        subscribe: (input: { sessionId: string }, observer: Observer) => {
          sessionSubscriptions += 1;
          sessionObservers.set(input.sessionId, observer);
          return {
            unsubscribe: () => sessionObservers.delete(input.sessionId),
          };
        },
      },
    }),
    snapshot: async () => shellSnapshot(1),
  };
  const store = new DashboardLiveStore();
  const runtime = new DashboardConnectionRuntime({
    client: client as never,
    store,
    isOnline: () => true,
  });
  return {
    client,
    runtime,
    store,
    shell: (value: unknown) => shellObserver?.onData(value),
    session: (id: string, value: unknown) =>
      sessionObservers.get(id)?.onData(value),
    counts: () => ({ shellSubscriptions, sessionSubscriptions }),
  };
}

describe('DashboardConnectionRuntime', () => {
  it('owns one shell subscription and reference-counts session feeds', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.counts().shellSubscriptions).toBe(1);
    const first = f.runtime.acquireSession('session-a');
    const second = f.runtime.acquireSession('session-a');
    await Promise.resolve();
    expect(f.counts().sessionSubscriptions).toBe(1);
    first.release();
    expect(f.counts().sessionSubscriptions).toBe(1);
    second.release();
    f.shell({ id: 'shell-00000001', data: { type: 'caught-up', sequence: 0 } });
    expect(f.store.getSnapshot().shellSync.status).toBe('live');
    stop();
  });

  it('keeps shell and session synchronization independent and rejects duplicates', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const handle = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shell({
      id: 'shell-00000001',
      data: {
        type: 'snapshot',
        sequence: 1,
        snapshot: { snapshot: shellSnapshot(1), cursor: 1 },
      },
    });
    f.session('session-a', {
      id: 'session-00000001',
      data: { type: 'snapshot', sequence: 1, snapshot: sessionSnapshot(1) },
    });
    f.shell({ id: 'shell-00000002', data: { type: 'caught-up', sequence: 1 } });
    expect(f.store.getSnapshot().shellSync.status).toBe('live');
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'synchronizing',
    );
    f.session('session-a', {
      id: 'session-00000002',
      data: { type: 'caught-up', sequence: 1 },
    });
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'live',
    );
    f.session('session-a', {
      id: 'session-00000002',
      data: { type: 'caught-up', sequence: 1 },
    });
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.sequence).toBe(
      1,
    );
    handle.release();
    stop();
  });

  it('hydrates zero-sequence shell and dormant session snapshots before catch-up', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const handle = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shell({
      id: 'shell-zero',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
      },
    });
    f.session('session-a', {
      id: 'session-zero',
      data: { type: 'snapshot', sequence: 0, snapshot: sessionSnapshot(0) },
    });
    expect(f.store.getSnapshot().serverId).toBe('daemon-1');
    expect(
      f.store.getSnapshot().transcriptsBySessionId['session-a'],
    ).toBeDefined();
    expect(f.store.getSnapshot().shellSync.status).toBe('synchronizing');
    f.shell({
      id: 'shell-caught-up',
      data: { type: 'caught-up', sequence: 0 },
    });
    f.session('session-a', {
      id: 'session-caught-up',
      data: { type: 'caught-up', sequence: 0 },
    });
    expect(f.store.getSnapshot().shellSync.status).toBe('live');
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'live',
    );
    handle.release();
    stop();
  });

  it('rebases only the domain with a single missing sequence', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const a = f.runtime.acquireSession('session-a');
    const b = f.runtime.acquireSession('session-b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shell({
      id: 'shell-zero',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
      },
    });
    f.shell({
      id: 'shell-gap',
      data: {
        type: 'shell-event',
        sequence: 2,
        domain: 'invalidation',
        revision: 2,
        data: { refresh: true },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.counts().shellSubscriptions).toBe(2);
    f.session('session-a', {
      id: 'a-zero',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: sessionSnapshot(0, 'session-a'),
      },
    });
    f.session('session-b', {
      id: 'b-zero',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: sessionSnapshot(0, 'session-b'),
      },
    });
    f.session('session-a', {
      id: 'a-gap',
      data: {
        type: 'session-event',
        sequence: 2,
        sessionId: 'session-a',
        event: { type: 'agent.settled', sessionId: 'session-a' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.counts().sessionSubscriptions).toBe(3);
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'synchronizing',
    );
    expect(f.store.getSnapshot().sessionSyncById['session-b']?.status).toBe(
      'synchronizing',
    );
    f.session('session-a', {
      id: 'a-rebase-snapshot',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: sessionSnapshot(0, 'session-a'),
      },
    });
    f.session('session-a', {
      id: 'a-rebase-caught-up',
      data: { type: 'caught-up', sequence: 0 },
    });
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'live',
    );
    a.release();
    b.release();
    stop();
  });

  it('drains a shell refresh race and waits for caught-up coverage', async () => {
    let resolveFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let reads = 0;
    let shellObserver: Observer | undefined;
    const client = {
      getTrpcClient: async () => ({
        shellSubscribe: {
          subscribe: (_input: unknown, observer: Observer) => {
            shellObserver = observer;
            return { unsubscribe: () => undefined };
          },
        },
        sessionSubscribe: {
          subscribe: () => ({ unsubscribe: () => undefined }),
        },
      }),
      snapshot: async () => {
        reads += 1;
        if (reads === 1) await firstReady;
        return shellSnapshot(reads);
      },
    };
    const store = new DashboardLiveStore();
    const runtime = new DashboardConnectionRuntime({
      client: client as never,
      store,
      isOnline: () => true,
    });
    const stop = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    shellObserver?.onData({
      id: 'shell-one',
      data: {
        type: 'shell-event',
        sequence: 1,
        domain: 'invalidation',
        revision: 1,
        data: { refresh: true },
      },
    });
    shellObserver?.onData({
      id: 'shell-two',
      data: {
        type: 'shell-event',
        sequence: 2,
        domain: 'invalidation',
        revision: 2,
        data: { refresh: true },
      },
    });
    shellObserver?.onData({
      id: 'shell-caught-up',
      data: { type: 'caught-up', sequence: 2 },
    });
    expect(store.getSnapshot().shellSync.status).toBe('synchronizing');
    resolveFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    expect(store.getSnapshot().snapshotCursor).toBe(2);
    expect(store.getSnapshot().shellSync.status).toBe('live');
    stop();
  });
});
