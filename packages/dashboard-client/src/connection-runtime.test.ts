import type {
  AuthoritativeSessionSnapshot,
  BrowserSnapshot,
} from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { DashboardConnectionRuntime } from './connection-runtime.js';
import { DashboardLiveStore } from './store.js';

const shellSnapshot = (
  cursor: number,
  serverId = 'daemon-1',
): BrowserSnapshot =>
  ({
    serverId,
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
  serverId = 'daemon-1',
): AuthoritativeSessionSnapshot =>
  ({
    serverId,
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
        domain: 'usage',
        revision: 2,
        data: { usage: { refresh: true } },
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

  it('accepts daemon-generation snapshots and reacquires referenced sessions', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const a = f.runtime.acquireSession('session-a');
    const b = f.runtime.acquireSession('session-b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shell({
      id: 'shell-old',
      data: {
        type: 'snapshot',
        sequence: 5,
        snapshot: { snapshot: shellSnapshot(5), cursor: 5 },
      },
    });
    f.shell({ id: 'shell-old-live', data: { type: 'caught-up', sequence: 5 } });
    f.session('session-a', {
      id: 'a-old',
      data: { type: 'snapshot', sequence: 5, snapshot: sessionSnapshot(5) },
    });
    f.session('session-a', {
      id: 'a-old-live',
      data: { type: 'caught-up', sequence: 5 },
    });
    f.session('session-b', {
      id: 'b-old',
      data: {
        type: 'snapshot',
        sequence: 5,
        snapshot: sessionSnapshot(5, 'session-b'),
      },
    });
    f.session('session-b', {
      id: 'b-old-live',
      data: { type: 'caught-up', sequence: 5 },
    });
    expect(f.store.getSnapshot().shellSync.status).toBe('live');
    f.shell({
      id: 'shell-new',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0, 'daemon-2'), cursor: 0 },
      },
    });
    expect(f.store.getSnapshot().serverId).toBe('daemon-2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.counts().sessionSubscriptions).toBe(4);
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'synchronizing',
    );
    f.session('session-a', {
      id: 'a-new',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: sessionSnapshot(0, 'session-a', 'daemon-2'),
      },
    });
    f.session('session-a', {
      id: 'a-new-live',
      data: { type: 'caught-up', sequence: 0 },
    });
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'live',
    );
    a.release();
    b.release();
    stop();
  });

  it('accepts a same-generation lower snapshot for only its session', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const a = f.runtime.acquireSession('session-a');
    const b = f.runtime.acquireSession('session-b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [id, sessionId] of [
      ['a-five', 'session-a'],
      ['b-five', 'session-b'],
    ] as const) {
      f.session(sessionId, {
        id,
        data: {
          type: 'snapshot',
          sequence: 5,
          snapshot: sessionSnapshot(5, sessionId),
        },
      });
      f.session(sessionId, {
        id: `${id}-live`,
        data: { type: 'caught-up', sequence: 5 },
      });
    }
    f.session('session-a', {
      id: 'a-rebase',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: sessionSnapshot(0, 'session-a'),
      },
    });
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.sequence).toBe(
      0,
    );
    expect(f.store.getSnapshot().sessionSyncById['session-b']?.status).toBe(
      'live',
    );
    f.session('session-a', {
      id: 'a-rebase-live',
      data: { type: 'caught-up', sequence: 0 },
    });
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'live',
    );
    a.release();
    b.release();
    stop();
  });

  it('defers a new-server session snapshot until shell authority resets', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const handle = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shell({
      id: 'shell-old',
      data: {
        type: 'snapshot',
        sequence: 5,
        snapshot: { snapshot: shellSnapshot(5), cursor: 5 },
      },
    });
    f.session('session-a', {
      id: 'a-new-before-shell',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: sessionSnapshot(0, 'session-a', 'daemon-2'),
      },
    });
    expect(f.store.getSnapshot().serverId).toBe('daemon-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shell({
      id: 'shell-new-authority',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0, 'daemon-2'), cursor: 0 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.session('session-a', {
      id: 'a-new-after-shell',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: sessionSnapshot(0, 'session-a', 'daemon-2'),
      },
    });
    f.session('session-a', {
      id: 'a-new-live',
      data: { type: 'caught-up', sequence: 0 },
    });
    expect(f.store.getSnapshot().serverId).toBe('daemon-2');
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'live',
    );
    handle.release();
    stop();
  });

  it('does not apply the same tracked snapshot twice', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const handle = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shell({
      id: 'shell-snapshot',
      data: {
        type: 'snapshot',
        sequence: 5,
        snapshot: { snapshot: shellSnapshot(5), cursor: 5 },
      },
    });
    f.shell({
      id: 'shell-snapshot-live',
      data: { type: 'caught-up', sequence: 5 },
    });
    f.shell({
      id: 'shell-snapshot',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0, 'daemon-2'), cursor: 0 },
      },
    });
    expect(f.store.getSnapshot().serverId).toBe('daemon-1');
    expect(f.store.getSnapshot().snapshotCursor).toBe(5);
    handle.release();
    stop();
  });

  it('applies a burst of shell patches without finite snapshot reads', async () => {
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
      id: 'shell-zero',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
      },
    });
    for (let sequence = 1; sequence <= 32; sequence += 1)
      shellObserver?.onData({
        id: `shell-${sequence}`,
        data: {
          type: 'shell-event',
          sequence,
          domain: 'usage',
          revision: sequence,
          data: { usage: { refresh: sequence } },
        },
      });
    shellObserver?.onData({
      id: 'shell-caught-up',
      data: { type: 'caught-up', sequence: 32 },
    });
    expect(store.getSnapshot().usage).toEqual({ refresh: 32 });
    expect(store.getSnapshot().shellSync.sequence).toBe(32);
    expect(store.getSnapshot().shellSync.status).toBe('live');
    expect(store.getSnapshot().snapshotCursor).toBe(0);
    expect(reads).toBe(0);
    stop();
  });

  it('explicitly reconnects after an initial shell open failure', async () => {
    let attempts = 0;
    let observer: Observer | undefined;
    const client = {
      getTrpcClient: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        return {
          shellSubscribe: {
            subscribe: (_input: unknown, next: Observer) => {
              observer = next;
              return { unsubscribe: () => undefined };
            },
          },
          sessionSubscribe: {
            subscribe: () => ({ unsubscribe: () => undefined }),
          },
        };
      },
      snapshot: async () => shellSnapshot(0),
    };
    const store = new DashboardLiveStore();
    const runtime = new DashboardConnectionRuntime({
      client: client as never,
      store,
      isOnline: () => true,
    });
    const stop = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getSnapshot().connection.status).toBe('error');
    runtime.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(2);
    observer?.onData({
      id: 'recovered-snapshot',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
      },
    });
    observer?.onData({
      id: 'recovered-live',
      data: { type: 'caught-up', sequence: 0 },
    });
    expect(store.getSnapshot().serverId).toBe('daemon-1');
    expect(store.getSnapshot().shellSync.status).toBe('live');
    stop();
  });

  it('explicitly rebases only the requested acquired session', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const a = f.runtime.acquireSession('session-a');
    const b = f.runtime.acquireSession('session-b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.counts().sessionSubscriptions).toBe(2);
    f.runtime.reconnectSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.counts().sessionSubscriptions).toBe(3);
    a.release();
    b.release();
    stop();
  });
});
