import type {
  BrowserSnapshot,
  SessionApiResponse,
} from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { DashboardLiveStore, sessionCursorRangeCovered } from './store.js';

const snapshot = (serverId: string, cursor: number): BrowserSnapshot =>
  ({
    serverId,
    revision: cursor,
    cursor,
    runtimes: [],
    workspaces: [],
    sessions: [],
    unread: [],
  }) as BrowserSnapshot;

type StreamRecord = Parameters<DashboardLiveStore['acceptStreamRecord']>[0];

const envelope = (cursor: number, sessionId = 'session-1'): StreamRecord =>
  ({
    cursor,
    emittedAt: cursor,
    sessionId,
    event: { type: 'agent.settled', sessionId },
  }) as StreamRecord;

const sessionResponse = (
  cursor: number,
  serverId = 'daemon-1',
): SessionApiResponse =>
  ({
    serverId,
    cursor,
    metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: cursor },
    entries: [],
  }) as SessionApiResponse;

describe('DashboardLiveStore', () => {
  it('applies patch-only runtime state to the live snapshot', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [
        {
          runtimeId: 'runtime-1',
          liveState: 'working',
          pendingInteractions: [],
          extensionSurfaces: [],
          session: { id: 'session-1', entries: [] },
        },
      ],
    } as unknown as BrowserSnapshot);

    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      runtimeId: 'runtime-1',
      event: {
        type: 'runtime.stateChanged',
        state: 'waiting',
        snapshot: {
          pendingInteractions: [
            {
              id: 'question-1',
              type: 'ask_user',
              question: 'Continue?',
              choices: [],
              allowCustom: false,
              createdAt: 2,
            },
          ],
          extensionSurfaces: [
            {
              id: 'delegate.status',
              rendererId: 'delegate.status',
              viewModel: { statuses: [] },
            },
          ],
        },
      },
    } as unknown as StreamRecord);

    expect(store.getSnapshot().snapshot?.runtimes[0]).toMatchObject({
      liveState: 'waiting',
      pendingInteractions: [{ id: 'question-1' }],
      extensionSurfaces: [{ id: 'delegate.status' }],
    });
    expect(store.getSnapshot().runtimesById['runtime-1']).toMatchObject({
      pendingInteractions: [{ id: 'question-1' }],
      extensionSurfaces: [{ id: 'delegate.status' }],
    });
  });

  it('keeps entity indexes and embedded snapshot projections aligned across ingress paths', () => {
    const store = new DashboardLiveStore();
    const runtime = {
      runtimeId: 'runtime-1',
      liveState: 'working',
      pendingInteractions: [],
      extensionSurfaces: [],
      session: { id: 'session-1', entries: [] },
    };
    const metadata = {
      id: 'session-1',
      file: '',
      cwd: '/tmp',
      updatedAt: 1,
    };
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [runtime],
      sessions: [metadata],
    } as unknown as BrowserSnapshot);

    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      runtimeId: 'runtime-1',
      event: {
        type: 'runtime.stateChanged',
        state: 'waiting',
        snapshot: { pendingInteractions: [] },
      },
    } as unknown as StreamRecord);
    const afterEvent = store.getSnapshot();
    expect(afterEvent.snapshot?.runtimes).toContainEqual(
      afterEvent.runtimesById['runtime-1'],
    );

    store.applyMutationResult({
      serverId: 'daemon-1',
      cursor: 2,
      metadata: { ...metadata, title: 'from HTTP' },
      entries: [],
    });
    const afterMutation = store.getSnapshot();
    expect(afterMutation.snapshot?.sessions).toContainEqual(
      afterMutation.sessionsById['session-1'],
    );
    expect(afterMutation.snapshot?.sessions).toHaveLength(1);
  });

  it('keeps bounded cursor/event history and rejects replay gaps', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 4));
    store.acceptStreamRecord(envelope(5));
    expect(() => store.acceptStreamRecord(envelope(7))).toThrow('replay');
    store.acceptStreamRecord(envelope(6));
    const state = store.getSnapshot();
    expect(state.cursor).toBe(6);
    expect(state.cursorHistory).toEqual([4, 5, 6]);
    expect(state.recentEvents.map((item) => item.cursor)).toEqual([5, 6]);
  });

  it('does not let an HTTP snapshot skip pending SSE transcript replay', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 5), {
      source: 'http',
      requestGeneration: 0,
    });
    expect(store.getSnapshot().cursor).toBe(0);
    store.hydrateSession(sessionResponse(5));

    for (const [cursor, type, content] of [
      [1, 'message.started', ''],
      [2, 'message.updated', 'hel'],
      [3, 'message.updated', 'hello'],
      [4, 'message.finished', 'hello'],
    ] as const)
      store.acceptStreamRecord({
        cursor,
        emittedAt: cursor,
        sessionId: 'session-1',
        event: {
          type,
          sessionId: 'session-1',
          message: {
            messageId: 'answer-1',
            role: 'assistant',
            content,
            phase: type.split('.')[1],
          },
        },
      } as StreamRecord);
    store.acceptStreamRecord(envelope(5));

    expect(store.getSnapshot().cursor).toBe(5);
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1']?.items[
        'answer-1'
      ],
    ).toMatchObject({ content: 'hello', status: 'finished' });
  });

  it('advances replay without regressing a newer HTTP projection', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 5), {
      source: 'http',
      requestGeneration: 0,
    });
    expect(
      store.acceptStreamRecord({
        type: 'snapshot',
        cursor: 1,
        emittedAt: 1,
        snapshot: snapshot('daemon-1', 1),
      } as StreamRecord),
    ).toBe(true);
    expect(store.getSnapshot().cursor).toBe(1);
    expect(store.getSnapshot().snapshot?.cursor).toBe(5);
  });

  it('rebases the stream cursor after a replay gap snapshot', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 5), {
      source: 'http',
      requestGeneration: 0,
    });
    store.installSnapshot(snapshot('daemon-1', 8), {
      source: 'http',
      requestGeneration: 0,
      rebaseCursor: true,
    });
    expect(store.getSnapshot().cursor).toBe(8);
    expect(store.getSnapshot().cursorHistory).toEqual([8]);
  });

  it('hydrates at an HTTP cursor and replays buffered records newer than it', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 3));
    store.acceptStreamRecord(envelope(4));
    store.acceptStreamRecord(envelope(5));
    const projection = store.hydrateSession(sessionResponse(3));
    expect(projection?.sessionId).toBe('session-1');
    expect(projection?.lastCursor).toBe(5);
    expect(store.getSnapshot().transcriptsBySessionId['session-1']).toBe(
      projection,
    );
  });

  it('reconciles a terminal tool event covered by the HTTP cursor', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      sessionId: 'session-1',
      event: {
        type: 'tool.finished',
        sessionId: 'session-1',
        tool: {
          toolCallId: 'call-1',
          name: 'read',
          result: 'done',
          status: 'completed',
        },
      },
    } as never);
    const projection = store.hydrateSession({
      ...sessionResponse(2),
      entries: [{ type: 'tool', tool: { toolCallId: 'call-1', name: 'read' } }],
    });
    expect(projection?.items['call-1']).toMatchObject({
      status: 'finished',
      result: 'done',
    });
  });

  it('does not let stale HTTP hydration resurrect a complete tree replacement', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 4));
    store.acceptStreamRecord({
      cursor: 5,
      emittedAt: 5,
      event: {
        type: 'session.snapshot',
        session: {
          id: 'session-1',
          entriesComplete: true,
          entries: [
            {
              type: 'message',
              message: { id: 'new-tail', role: 'user', content: 'new' },
            },
          ],
        },
      },
    } as never);
    const projection = store.hydrateSession({
      ...sessionResponse(5),
      entries: [
        {
          type: 'message',
          message: { id: 'old-tail', role: 'user', content: 'old' },
        },
      ],
    });
    expect(projection?.items['new-tail']).toBeDefined();
    expect(projection?.items['old-tail']).toBeUndefined();
  });

  it('attributes reconnect hydration to the response runtime epoch', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.hydrateSession({
      ...sessionResponse(1),
      runtimeEpoch: 'epoch-a',
      runtimeSeq: 0,
      entries: [
        {
          type: 'message',
          message: { id: 'history-a', role: 'user', content: 'before' },
        },
      ],
    });
    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      runtimeEpoch: 'epoch-a',
      runtimeSeq: 1,
      sessionId: 'session-1',
      event: {
        type: 'message.finished',
        sessionId: 'session-1',
        message: {
          messageId: 'answer-a',
          role: 'assistant',
          content: 'answer',
          phase: 'finished',
        },
      },
    } as never);
    store.acceptStreamRecord({
      type: 'snapshot',
      cursor: 3,
      emittedAt: 3,
      snapshot: snapshot('daemon-1', 3),
    } as StreamRecord);
    const hydrated = store.hydrateSession({
      ...sessionResponse(3),
      runtimeEpoch: 'epoch-b',
      runtimeSeq: 0,
      entries: [
        {
          type: 'message',
          message: { id: 'history-a', role: 'user', content: 'before' },
        },
        {
          type: 'message',
          message: { id: 'answer-a', role: 'assistant', content: 'answer' },
        },
      ],
    });
    expect(hydrated?.runtimeEpoch).toBe('epoch-b');
    expect(hydrated?.retiredEpochs).toContain('epoch-a');
    const next = store.acceptStreamRecord({
      cursor: 4,
      emittedAt: 4,
      runtimeEpoch: 'epoch-b',
      runtimeSeq: 1,
      sessionId: 'session-1',
      event: {
        type: 'message.finished',
        sessionId: 'session-1',
        message: {
          messageId: 'answer-b',
          role: 'assistant',
          content: 'after reconnect',
          phase: 'finished',
        },
      },
    } as never);
    expect(next).toBe(true);
    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.items['history-a']).toBeDefined();
    expect(projection?.items['answer-a']).toBeDefined();
    expect(projection?.items['answer-b']).toBeDefined();
  });

  it('does not resurrect stale HTTP entries after a live branch ages out', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      event: {
        type: 'session.snapshot',
        session: {
          id: 'session-1',
          entriesComplete: true,
          entries: [
            {
              type: 'message',
              message: { id: 'new-tail', role: 'user', content: 'new' },
            },
          ],
        },
      },
    } as never);
    for (let cursor = 3; cursor <= 260; cursor += 1)
      store.acceptStreamRecord(envelope(cursor, 'session-2'));

    const projection = store.hydrateSession({
      ...sessionResponse(260),
      entries: [
        {
          type: 'message',
          message: { id: 'old-tail', role: 'user', content: 'old' },
        },
      ],
    });
    expect(projection?.items['new-tail']).toBeDefined();
    expect(projection?.items['old-tail']).toBeUndefined();
  });

  it('replays a tree replacement beyond the former 64-event overlap', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      event: {
        type: 'session.snapshot',
        session: {
          id: 'session-1',
          entriesComplete: true,
          entries: [
            {
              type: 'message',
              message: { id: 'new-tail', role: 'user', content: 'new' },
            },
          ],
        },
      },
    } as never);
    for (let cursor = 3; cursor <= 72; cursor += 1)
      store.acceptStreamRecord(envelope(cursor));
    const projection = store.hydrateSession({
      ...sessionResponse(72),
      entries: [
        {
          type: 'message',
          message: { id: 'old-tail', role: 'user', content: 'old' },
        },
      ],
    });
    expect(projection?.items['new-tail']).toBeDefined();
    expect(projection?.items['old-tail']).toBeUndefined();
  });

  it('publishes semantic session changes and replacement targets without raw page events', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 4),
      runtimes: [
        {
          runtimeId: 'runtime-1',
          session: { id: 'old-session', entries: [] },
        },
      ],
      sessions: [{ id: 'old-session', file: '', cwd: '/tmp', updatedAt: 1 }],
    } as unknown as BrowserSnapshot);
    store.acceptStreamRecord({
      cursor: 5,
      emittedAt: 5,
      runtimeId: 'runtime-1',
      event: {
        type: 'session.changed',
        session: { id: 'new-session', entries: [], name: 'New session' },
      },
    } as StreamRecord);
    expect(store.getSnapshot().sessionChangeById['new-session']).toBe(1);
    expect(
      store.getSnapshot().sessionReplacementBySessionId['old-session'],
    ).toBe('new-session');
  });

  it('resets state for daemon replacement and refuses stale HTTP generations', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 12));
    store.installSnapshot(snapshot('daemon-2', 1), { source: 'sse' });
    expect(store.getSnapshot().serverId).toBe('daemon-2');
    expect(store.getSnapshot().cursor).toBe(1);
    expect(store.getSnapshot().connection.lastCursor).toBe(1);
    expect(store.getSnapshot().resyncNonce).toBe(1);
    expect(
      store.installSnapshot(snapshot('daemon-1', 13), {
        source: 'http',
        requestGeneration: 0,
      }),
    ).toBe(false);
    expect(
      store.hydrateSession(sessionResponse(1, 'daemon-1')),
    ).toBeUndefined();
  });

  it('rejects a session response from the replaced daemon generation', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-a', 4));
    store.installSnapshot(snapshot('daemon-b', 1), { source: 'sse' });
    expect(
      store.hydrateSession(sessionResponse(1, 'daemon-a')),
    ).toBeUndefined();
    expect(store.hydrateSession(sessionResponse(1, 'daemon-b'))).toBeDefined();
  });
});

describe('session cursor coverage', () => {
  it('requires all cursors between an HTTP read and current live state', () => {
    expect(sessionCursorRangeCovered(4, 7, [5, 6, 7])).toBe(true);
    expect(sessionCursorRangeCovered(4, 7, [6, 7])).toBe(false);
    expect(sessionCursorRangeCovered(4, 4, [])).toBe(true);
  });
});
