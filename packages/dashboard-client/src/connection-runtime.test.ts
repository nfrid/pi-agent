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

const sessionSnapshot = (cursor: number): AuthoritativeSessionSnapshot =>
  ({
    serverId: 'daemon-1',
    cursor,
    metadata: { id: 'session-a', file: '', cwd: '/tmp', updatedAt: cursor },
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
});
