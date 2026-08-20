import type {
  AuthoritativeSessionSnapshot,
  BrowserSnapshot,
} from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  DashboardConnectionRuntime,
  SESSION_PROJECTION_CACHE_LIMIT,
} from './connection-runtime.js';
import {
  InMemorySessionTranscriptCache,
  type SessionTranscriptCache,
} from './session-transcript-cache.js';
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
): AuthoritativeSessionSnapshot => ({
  serverId,
  cursor,
  metadata: { id, file: '', cwd: '/tmp', updatedAt: cursor },
  entries: [],
  history: { version: 1, start: 0, end: 0, hasOlder: false },
  entriesComplete: true,
  active: {
    pendingInteractions: [],
    messages: [],
    tools: [],
    delegates: [],
    truncated: false,
  },
  completeThroughCursor: true,
});

type Observer = {
  onData: (value: unknown) => void;
  onError?: (error: unknown) => void;
};

function lifecycleGlobals() {
  type Listener = () => void;
  class EventTargetShim {
    private readonly listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, listener: Listener): void {
      let listeners = this.listeners.get(type);
      if (!listeners) {
        listeners = new Set();
        this.listeners.set(type, listeners);
      }
      listeners.add(listener);
    }
    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    }
    dispatch(type: string): void {
      for (const listener of this.listeners.get(type) ?? []) listener();
    }
  }
  const root = globalThis as unknown as {
    window?: unknown;
    document?: unknown;
  };
  const previousWindow = root.window;
  const previousDocument = root.document;
  const windowTarget = new EventTargetShim();
  const documentTarget = new EventTargetShim() as EventTargetShim & {
    visibilityState: Document['visibilityState'];
  };
  documentTarget.visibilityState = 'visible';
  root.window = windowTarget;
  root.document = documentTarget;
  return {
    window: windowTarget,
    document: documentTarget,
    restore: () => {
      if (previousWindow === undefined) delete root.window;
      else root.window = previousWindow;
      if (previousDocument === undefined) delete root.document;
      else root.document = previousDocument;
    },
  };
}

function fixture(sessionTranscriptCache?: SessionTranscriptCache) {
  let shellObserver: Observer | undefined;
  const shellHistory: Observer[] = [];
  const sessionObservers = new Map<string, Observer>();
  let shellSubscriptions = 0;
  let sessionSubscriptions = 0;
  const sessionInputs: Array<{
    sessionId: string;
    lastEventId?: string;
  }> = [];
  const client = {
    getTrpcClient: async () => ({
      shellSubscribe: {
        subscribe: (_input: unknown, observer: Observer) => {
          shellSubscriptions += 1;
          shellObserver = observer;
          shellHistory.push(observer);
          return {
            unsubscribe: () => {
              if (shellObserver === observer) shellObserver = undefined;
            },
          };
        },
      },
      sessionSubscribe: {
        subscribe: (
          input: { sessionId: string; lastEventId?: string },
          observer: Observer,
        ) => {
          sessionSubscriptions += 1;
          sessionInputs.push(input);
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
    ...(sessionTranscriptCache ? { sessionTranscriptCache } : {}),
  });
  return {
    client,
    runtime,
    store,
    shell: (value: unknown) => shellObserver?.onData(value),
    shellError: (error: unknown) => shellObserver?.onError?.(error),
    session: (id: string, value: unknown) =>
      sessionObservers.get(id)?.onData(value),
    sessionError: (id: string, error: unknown) =>
      sessionObservers.get(id)?.onError?.(error),
    shellHistory,
    counts: () => ({ shellSubscriptions, sessionSubscriptions }),
    sessionInputs,
  };
}

describe('DashboardConnectionRuntime', () => {
  it('classifies wrapped EventSource HTTP auth errors from their numeric code', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    f.shellError(
      Object.assign(new Error('Non-200 status code (401)'), {
        shape: {
          type: 'error',
          code: 401,
          message: 'Non-200 status code (401)',
        },
      }),
    );

    expect(f.store.getSnapshot().connection).toMatchObject({
      status: 'blocked',
      errorKind: 'authentication',
    });
    stop();
  });

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

  it('renders a released session from cache and resumes from its opaque cursor', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const first = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.session('session-a', {
      id: 'session-cursor-snapshot',
      data: {
        type: 'snapshot',
        sequence: 1,
        snapshot: {
          ...sessionSnapshot(1),
          entries: [
            {
              type: 'message',
              id: 'cached-message',
              message: { role: 'assistant', content: 'cached answer' },
            },
          ],
        },
      },
    });
    f.session('session-a', {
      id: 'session-cursor-live',
      data: { type: 'caught-up', sequence: 1 },
    });
    for (const [sequence, id, event] of [
      [
        2,
        'stream-started',
        {
          type: 'message.started',
          sessionId: 'session-a',
          message: {
            messageId: 'streaming-answer',
            role: 'assistant',
            content: '',
          },
        },
      ],
      [
        3,
        'stream-updated',
        {
          type: 'message.updated',
          sessionId: 'session-a',
          message: {
            messageId: 'streaming-answer',
            role: 'assistant',
            content: 'partial answer',
          },
        },
      ],
      [
        4,
        'tool-started',
        {
          type: 'tool.started',
          sessionId: 'session-a',
          tool: {
            toolCallId: 'running-tool',
            name: 'read',
            arguments: { path: '/tmp/file' },
            phase: 'started',
          },
        },
      ],
      [
        5,
        'tool-running',
        {
          type: 'tool.updated',
          sessionId: 'session-a',
          tool: {
            toolCallId: 'running-tool',
            name: 'read',
            status: 'running',
            phase: 'updated',
          },
        },
      ],
    ] as const)
      f.session('session-a', {
        id,
        data: {
          type: 'session-event',
          sequence,
          sessionId: 'session-a',
          event,
        },
      });
    first.release();

    expect(f.store.getSnapshot().sessionSyncById['session-a']).toMatchObject({
      status: 'cached',
      sequence: 5,
      sequenceKnown: true,
    });
    const cached = f.store.getSnapshot().transcriptsBySessionId['session-a'];
    expect(cached?.items['cached-message']).toBeDefined();
    expect(cached?.items['streaming-answer']).toMatchObject({
      kind: 'message',
      content: 'partial answer',
    });
    expect(cached?.items['running-tool']).toMatchObject({
      kind: 'tool',
      status: 'running',
    });

    const second = f.runtime.acquireSession('session-a');
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'synchronizing',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.sessionInputs.at(-1)).toEqual({
      sessionId: 'session-a',
      lastEventId: 'tool-running',
    });
    f.session('session-a', {
      id: 'session-cursor-replay',
      data: {
        type: 'session-event',
        sequence: 6,
        sessionId: 'session-a',
        event: { type: 'agent.settled', sessionId: 'session-a' },
      },
    });
    f.session('session-a', {
      id: 'session-cursor-caught-up',
      data: { type: 'caught-up', sequence: 6 },
    });
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'live',
    );
    second.release();
    stop();
  });

  it('restores a settled transcript from persistent cache before network hydration', async () => {
    const cache = new InMemorySessionTranscriptCache();
    const firstFixture = fixture(cache);
    const stopFirst = firstFixture.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstFixture.shell({
      id: 'shell-cache-snapshot',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
      },
    });
    const first = firstFixture.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstFixture.session('session-a', {
      id: 'persistent-session-snapshot',
      data: {
        type: 'snapshot',
        sequence: 2,
        snapshot: {
          ...sessionSnapshot(2),
          entries: [
            {
              type: 'message',
              id: 'persistent-message',
              message: { role: 'assistant', content: 'warm start' },
            },
          ],
        },
      },
    });
    firstFixture.session('session-a', {
      id: 'persistent-session-live',
      data: { type: 'caught-up', sequence: 2 },
    });
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopFirst();

    const secondFixture = fixture(cache);
    const stopSecond = secondFixture.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    secondFixture.shell({
      id: 'shell-restore-snapshot',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
      },
    });
    const second = secondFixture.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      secondFixture.store.getSnapshot().transcriptsBySessionId['session-a']
        ?.items['persistent-message'],
    ).toBeDefined();
    expect(
      secondFixture.store.getSnapshot().sessionSyncById['session-a'],
    ).toMatchObject({
      status: 'cached',
      sequence: 2,
      sequenceKnown: true,
    });
    second.release();
    stopSecond();
  });

  it('replaces a cached projection when resume falls back to a fresh snapshot', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const first = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.session('session-a', {
      id: 'old-snapshot',
      data: {
        type: 'snapshot',
        sequence: 1,
        snapshot: {
          ...sessionSnapshot(1),
          entries: [
            {
              type: 'message',
              id: 'old-message',
              message: { role: 'assistant', content: 'old' },
            },
          ],
        },
      },
    });
    first.release();
    const second = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.session('session-a', {
      id: 'fresh-snapshot',
      data: {
        type: 'snapshot',
        sequence: 8,
        snapshot: {
          ...sessionSnapshot(8),
          entries: [
            {
              type: 'message',
              id: 'fresh-message',
              message: { role: 'assistant', content: 'fresh' },
            },
          ],
        },
      },
    });
    const projection =
      f.store.getSnapshot().transcriptsBySessionId['session-a'];
    expect(projection?.items['fresh-message']).toBeDefined();
    expect(projection?.items['old-message']).toBeUndefined();
    second.release();
    stop();
  });

  it('evicts the least-recently released inactive session projection', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const ids = Array.from(
      { length: SESSION_PROJECTION_CACHE_LIMIT + 1 },
      (_, index) => `session-${index}`,
    );
    for (const [index, id] of ids.entries()) {
      const handle = f.runtime.acquireSession(id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      f.session(id, {
        id: `snapshot-${index}`,
        data: {
          type: 'snapshot',
          sequence: index,
          snapshot: sessionSnapshot(index, id),
        },
      });
      handle.release();
    }

    const oldest = ids[0] as string;
    expect(f.store.getSnapshot().sessionSnapshotsById[oldest]).toBeUndefined();
    expect(
      f.store.getSnapshot().transcriptsBySessionId[oldest],
    ).toBeUndefined();
    for (const retained of ids.slice(1))
      expect(f.store.getSnapshot().sessionSyncById[retained]?.status).toBe(
        'cached',
      );
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

  it('rebases only the target session on an auxiliary transcript reset', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const a = f.runtime.acquireSession('session-a');
    const b = f.runtime.acquireSession('session-b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shell({
      id: 'shell-reset-test',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
      },
    });
    f.shell({
      id: 'shell-reset-live',
      data: { type: 'caught-up', sequence: 0 },
    });
    for (const id of ['session-a', 'session-b']) {
      f.session(id, {
        id: `${id}-snapshot`,
        data: {
          type: 'snapshot',
          sequence: 0,
          snapshot: sessionSnapshot(0, id),
        },
      });
      f.session(id, {
        id: `${id}-live`,
        data: { type: 'caught-up', sequence: 0 },
      });
    }
    const before = f.counts().sessionSubscriptions;
    f.session('session-a', {
      id: 'a-reset',
      data: {
        type: 'session-event',
        sequence: 1,
        sessionId: 'session-a',
        event: {
          type: 'session.transcript.reset',
          sessionId: 'session-a',
          reason: 'source-rewrite',
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.counts().sessionSubscriptions).toBe(before + 1);
    expect(f.store.getSnapshot().sessionSyncById['session-b']).toMatchObject({
      status: 'live',
      generation: 1,
    });
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'synchronizing',
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

  it('blocks globally on session authentication and ignores stale shell events', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const handle = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const priorShellObserver = f.shellHistory[0];
    f.sessionError(
      'session-a',
      Object.assign(new Error('Session unauthorized'), {
        shape: { code: 401 },
      }),
    );
    expect(f.store.getSnapshot().connection).toMatchObject({
      status: 'blocked',
      errorKind: 'authentication',
    });
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'empty',
    );
    priorShellObserver?.onData({
      id: 'stale-shell-snapshot',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
      },
    });
    priorShellObserver?.onData({
      id: 'stale-shell-live',
      data: { type: 'caught-up', sequence: 0 },
    });
    expect(f.store.getSnapshot().connection).toMatchObject({
      status: 'blocked',
      errorKind: 'authentication',
    });
    expect(f.counts()).toEqual({
      shellSubscriptions: 1,
      sessionSubscriptions: 1,
    });
    handle.release();
    stop();
  });

  it('keeps ordinary session network failures isolated from a healthy shell', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const handle = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shell({
      id: 'shell-snapshot',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
      },
    });
    f.shell({ id: 'shell-live', data: { type: 'caught-up', sequence: 0 } });
    f.sessionError('session-a', new Error('temporary session network failure'));
    expect(f.store.getSnapshot().connection.status).toBe('connected');
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'error',
    );
    handle.release();
    stop();
  });

  it('blocks shell authentication and closes acquired session subscriptions', async () => {
    const f = fixture();
    const stop = f.runtime.start();
    const handle = f.runtime.acquireSession('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.shellError(
      Object.assign(new Error('Dashboard unauthorized'), {
        shape: { code: 401 },
      }),
    );
    expect(f.store.getSnapshot().connection).toMatchObject({
      status: 'blocked',
      errorKind: 'authentication',
    });
    const priorShellObserver = f.shellHistory[0];
    priorShellObserver?.onData({
      id: 'stale-shell-live',
      data: { type: 'caught-up', sequence: 0 },
    });
    f.session('session-a', {
      id: 'stale-session-snapshot',
      data: {
        type: 'snapshot',
        sequence: 0,
        snapshot: sessionSnapshot(0),
      },
    });
    expect(f.store.getSnapshot().connection.status).toBe('blocked');
    expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
      'empty',
    );
    handle.release();
    stop();
  });

  it('does not install feeds when offline or stopped while client acquisition is pending', async () => {
    let online = true;
    let resolveClient!: (value: unknown) => void;
    const pendingClient = new Promise((resolve) => {
      resolveClient = resolve;
    });
    let shellSubscriptions = 0;
    const trpc = {
      shellSubscribe: {
        subscribe: () => {
          shellSubscriptions += 1;
          return { unsubscribe: () => undefined };
        },
      },
      sessionSubscribe: {
        subscribe: () => ({ unsubscribe: () => undefined }),
      },
    };
    const client = {
      getTrpcClient: () => pendingClient,
      snapshot: async () => shellSnapshot(0),
    };
    const store = new DashboardLiveStore();
    const runtime = new DashboardConnectionRuntime({
      client: client as never,
      store,
      isOnline: () => online,
    });
    const stop = runtime.start();
    online = false;
    runtime.reconnect();
    resolveClient(trpc);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shellSubscriptions).toBe(0);

    online = true;
    runtime.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shellSubscriptions).toBe(1);
    stop();

    let stoppedSubscriptions = 0;
    let resolveStopped!: (value: unknown) => void;
    const stoppedClient = {
      getTrpcClient: () =>
        new Promise((resolve) => {
          resolveStopped = resolve;
        }),
      snapshot: async () => shellSnapshot(0),
    };
    const stoppedRuntime = new DashboardConnectionRuntime({
      client: stoppedClient as never,
      store: new DashboardLiveStore(),
      isOnline: () => true,
    });
    const stoppedTrpc = {
      ...trpc,
      shellSubscribe: {
        subscribe: () => {
          stoppedSubscriptions += 1;
          return { unsubscribe: () => undefined };
        },
      },
    };
    const stopped = stoppedRuntime.start();
    stopped();
    resolveStopped(stoppedTrpc);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stoppedSubscriptions).toBe(0);
  });

  it('recovers online/offline feeds and replaces only after a stale hidden period', async () => {
    const globals = lifecycleGlobals();
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let online = false;
      const f = fixture();
      const runtime = new DashboardConnectionRuntime({
        client: f.client as never,
        store: f.store,
        isOnline: () => online,
        visibilityStaleMs: 5,
      });
      const stop = runtime.start();
      expect(f.counts().shellSubscriptions).toBe(0);

      online = true;
      globals.window.dispatch('online');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.counts().shellSubscriptions).toBe(1);

      globals.document.visibilityState = 'hidden';
      globals.document.dispatch('visibilitychange');
      now += 1;
      globals.document.visibilityState = 'visible';
      globals.document.dispatch('visibilitychange');
      expect(f.counts().shellSubscriptions).toBe(1);

      globals.document.visibilityState = 'hidden';
      globals.document.dispatch('visibilitychange');
      now += 10;
      globals.document.visibilityState = 'visible';
      globals.document.dispatch('visibilitychange');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.counts().shellSubscriptions).toBe(2);

      online = false;
      globals.window.dispatch('offline');
      expect(f.store.getSnapshot().connection.status).toBe('offline');
      online = true;
      globals.window.dispatch('online');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.counts().shellSubscriptions).toBe(3);

      stop();
      globals.window.dispatch('online');
      globals.document.visibilityState = 'hidden';
      globals.document.dispatch('visibilitychange');
      globals.document.visibilityState = 'visible';
      globals.document.dispatch('visibilitychange');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(f.counts().shellSubscriptions).toBe(3);
    } finally {
      clock.mockRestore();
      globals.restore();
    }
  });

  it('suspends live domains on offline and resumes them with preserved cuts', async () => {
    const globals = lifecycleGlobals();
    try {
      let online = true;
      const f = fixture();
      const runtime = new DashboardConnectionRuntime({
        client: f.client as never,
        store: f.store,
        isOnline: () => online,
      });
      const stop = runtime.start();
      const handle = runtime.acquireSession('session-a');
      await new Promise((resolve) => setTimeout(resolve, 0));
      f.shell({
        id: 'shell-snapshot',
        data: {
          type: 'snapshot',
          sequence: 0,
          snapshot: { snapshot: shellSnapshot(0), cursor: 0 },
        },
      });
      f.shell({ id: 'shell-live', data: { type: 'caught-up', sequence: 0 } });
      f.session('session-a', {
        id: 'session-snapshot',
        data: { type: 'snapshot', sequence: 0, snapshot: sessionSnapshot(0) },
      });
      f.session('session-a', {
        id: 'session-live',
        data: { type: 'caught-up', sequence: 0 },
      });
      expect(f.store.getSnapshot().shellSync.status).toBe('live');
      expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
        'live',
      );

      online = false;
      globals.window.dispatch('offline');
      expect(f.store.getSnapshot().connection.status).toBe('offline');
      expect(f.store.getSnapshot().shellSync).toMatchObject({
        status: 'cached',
        sequence: 0,
        sequenceKnown: true,
      });
      expect(f.store.getSnapshot().sessionSyncById['session-a']).toMatchObject({
        status: 'cached',
        sequence: 0,
        sequenceKnown: true,
      });

      online = true;
      globals.window.dispatch('online');
      expect(f.store.getSnapshot().shellSync.status).toBe('synchronizing');
      expect(f.store.getSnapshot().sessionSyncById['session-a']?.status).toBe(
        'synchronizing',
      );
      handle.release();
      stop();
    } finally {
      globals.restore();
    }
  });

  it('latches authentication and protocol blocks against automatic retries', async () => {
    const globals = lifecycleGlobals();
    try {
      const f = fixture();
      const stop = f.runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      f.shellError(
        Object.assign(new Error('unauthorized'), { shape: { code: 401 } }),
      );
      const blockedCount = f.counts().shellSubscriptions;
      globals.window.dispatch('online');
      globals.document.visibilityState = 'hidden';
      globals.document.dispatch('visibilitychange');
      globals.document.visibilityState = 'visible';
      globals.document.dispatch('visibilitychange');
      f.runtime.reconnect();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.counts().shellSubscriptions).toBe(blockedCount);
      f.runtime.retryAuthentication();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.counts().shellSubscriptions).toBe(blockedCount + 1);
      f.shellError({
        data: { domainCode: 'protocol-mismatch', actual: 3 },
      });
      const protocolBlockedCount = f.counts().shellSubscriptions;
      globals.window.dispatch('online');
      f.runtime.reconnect();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.counts().shellSubscriptions).toBe(protocolBlockedCount);
      stop();
    } finally {
      globals.restore();
    }
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
