import type {
  BrowserSnapshot,
  SessionApiResponse,
} from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  DashboardLiveStore,
  selectSnapshot,
  sessionCursorRangeCovered,
} from './store.js';

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
  it('optimistically titles the first prompt through settlement and reconciles authority', () => {
    const store = new DashboardLiveStore();
    const metadata = {
      id: 'session-1',
      file: '',
      cwd: '/tmp',
      updatedAt: 1,
    };
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      sessions: [metadata],
    } as unknown as BrowserSnapshot);

    expect(
      store.optimisticallyTitleSession('session-1', '  first request  '),
    ).toBe(true);
    expect(store.getSnapshot().sessionsById['session-1']?.title).toBe(
      'first request',
    );
    expect(store.getSnapshot().optimisticSessionTitlesById['session-1']).toBe(
      'first request',
    );
    store.hydrateSession(sessionResponse(1));
    expect(store.getSnapshot().sessionsById['session-1']?.title).toBe(
      'first request',
    );

    // Neither a live user message nor settlement may make the optimistic
    // title disappear while the session branch is still being persisted.
    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      sessionId: 'session-1',
      event: {
        type: 'message.finished',
        sessionId: 'session-1',
        message: {
          messageId: 'user-1',
          role: 'user',
          content: 'first request',
        },
      },
    } as StreamRecord);
    store.acceptStreamRecord({
      cursor: 3,
      emittedAt: 3,
      sessionId: 'session-1',
      event: { type: 'agent.settled', sessionId: 'session-1' },
    } as StreamRecord);
    expect(store.getSnapshot().sessionsById['session-1']?.title).toBe(
      'first request',
    );

    store.acceptStreamRecord({
      cursor: 4,
      emittedAt: 4,
      sessionId: 'session-1',
      event: {
        type: 'session.changed',
        session: { id: 'session-1', entries: [], title: 'Authoritative title' },
      },
    } as StreamRecord);
    expect(store.getSnapshot().sessionsById['session-1']?.title).toBe(
      'Authoritative title',
    );
    expect(
      store.getSnapshot().optimisticSessionTitlesById['session-1'],
    ).toBeUndefined();
  });

  it('does not replace an explicit session name with an optimistic prompt title', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      sessions: [
        {
          id: 'session-1',
          file: '',
          cwd: '/tmp',
          updatedAt: 1,
          name: 'Custom session',
        },
      ],
    } as unknown as BrowserSnapshot);

    expect(store.optimisticallyTitleSession('session-1', 'first request')).toBe(
      false,
    );
    expect(store.getSnapshot().sessionsById['session-1']?.name).toBe(
      'Custom session',
    );
  });

  it('hydrates normalized entities and retains notification/usage behavior', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      usage: { remaining: 3 },
      workspaces: [
        { id: 'workspace-1', name: 'Workspace', canonicalPath: '/tmp' },
      ],
      sessions: [{ id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 }],
      unread: [
        {
          id: 'notification-1',
          title: 'Question',
          body: 'Choose',
          createdAt: 1,
        },
      ],
    } as unknown as BrowserSnapshot);

    const hydrated = store.getSnapshot();
    expect(hydrated).not.toHaveProperty('snapshot');
    expect(hydrated.serverId).toBe('daemon-1');
    expect(selectSnapshot(hydrated)).toMatchObject({
      cursor: 1,
      usage: { remaining: 3 },
      workspaces: [{ id: 'workspace-1' }],
      sessions: [{ id: 'session-1' }],
      unread: [{ id: 'notification-1' }],
    });

    store.updateUsage({ remaining: 2 });
    store.markNotificationRead('notification-1');
    expect(store.getSnapshot().usage).toEqual({ remaining: 2 });
    expect(selectSnapshot(store.getSnapshot())?.unread).toEqual([]);
  });

  it('applies patch-only runtime state and invalidates stale runtime branches', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [
        {
          runtimeId: 'runtime-1',
          liveState: 'working',
          pendingInteractions: [],
          extensionSurfaces: [],
          session: {
            id: 'session-1',
            entries: [{ type: 'message', id: 'large-existing-branch' }],
          },
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
          session: {
            id: 'session-1',
            entries: [],
            entriesComplete: false,
          },
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

    expect(selectSnapshot(store.getSnapshot())?.runtimes[0]).toMatchObject({
      liveState: 'waiting',
      pendingInteractions: [{ id: 'question-1' }],
      extensionSurfaces: [{ id: 'delegate.status' }],
    });
    expect(store.getSnapshot().runtimesById['runtime-1']).toMatchObject({
      pendingInteractions: [{ id: 'question-1' }],
      extensionSurfaces: [{ id: 'delegate.status' }],
      session: {
        id: 'session-1',
        entries: [],
        entriesComplete: false,
      },
    });
  });

  it('retains runtime epoch ordering across no-snapshot browser events', () => {
    const store = new DashboardLiveStore();
    const runtime = {
      runtimeId: 'runtime-1',
      liveState: 'idle',
      pendingInteractions: [],
      extensionSurfaces: [],
      session: { id: 'session-1', entries: [] },
    };
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [runtime],
    } as unknown as BrowserSnapshot);

    const runtimeEvent = (
      cursor: number,
      runtimeEpoch: string,
      runtimeSeq: number,
      state: 'idle' | 'working' | 'waiting',
    ): StreamRecord =>
      ({
        cursor,
        emittedAt: cursor,
        runtimeId: 'runtime-1',
        runtimeEpoch,
        runtimeSeq,
        event: { type: 'runtime.stateChanged', state, snapshot: {} },
      }) as StreamRecord;

    store.acceptStreamRecord(runtimeEvent(2, 'epoch-a', 1, 'working'));
    store.acceptStreamRecord(runtimeEvent(3, 'epoch-b', 1, 'waiting'));
    expect(
      store.acceptStreamRecord(runtimeEvent(4, 'epoch-a', 99, 'idle')),
    ).toBe(true);
    expect(store.getSnapshot().runtimesById['runtime-1'].liveState).toBe(
      'waiting',
    );
  });

  it('synchronizes runtime ordering from authoritative snapshot events', () => {
    const store = new DashboardLiveStore();
    const runtime = {
      runtimeId: 'runtime-1',
      liveState: 'idle',
      pendingInteractions: [],
      extensionSurfaces: [],
      session: { id: 'session-1', entries: [] },
    };
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [runtime],
    } as unknown as BrowserSnapshot);
    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      runtimeId: 'runtime-1',
      runtimeEpoch: 'epoch-a',
      runtimeSeq: 1,
      event: {
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: {},
      },
    } as StreamRecord);

    const authoritative = {
      ...snapshot('daemon-1', 3),
      runtimes: [{ ...runtime, liveState: 'waiting' }],
    } as unknown as BrowserSnapshot;
    store.acceptStreamRecord({
      cursor: 3,
      emittedAt: 3,
      runtimeId: 'runtime-1',
      runtimeEpoch: 'epoch-b',
      runtimeSeq: 1,
      snapshot: authoritative,
      // Deliberately conflicts with the authoritative runtime projection.
      event: {
        type: 'runtime.stateChanged',
        state: 'idle',
        snapshot: {},
      },
    } as StreamRecord);
    expect(store.getSnapshot().runtimesById['runtime-1'].liveState).toBe(
      'waiting',
    );

    store.acceptStreamRecord({
      cursor: 4,
      emittedAt: 4,
      runtimeId: 'runtime-1',
      runtimeEpoch: 'epoch-a',
      runtimeSeq: 99,
      event: {
        type: 'runtime.stateChanged',
        state: 'idle',
        snapshot: {},
      },
    } as StreamRecord);
    expect(store.getSnapshot().runtimesById['runtime-1'].liveState).toBe(
      'waiting',
    );
  });

  it('materializes current entity indexes across ingress paths', () => {
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
    expect(afterEvent).not.toHaveProperty('snapshot');
    expect(selectSnapshot(afterEvent)?.runtimes).toContainEqual(
      afterEvent.runtimesById['runtime-1'],
    );

    store.applyMutationResult({
      serverId: 'daemon-1',
      cursor: 2,
      metadata: { ...metadata, title: 'from HTTP' },
      entries: [],
    });
    const afterMutation = store.getSnapshot();
    expect(selectSnapshot(afterMutation)?.sessions).toContainEqual(
      afterMutation.sessionsById['session-1'],
    );
    expect(selectSnapshot(afterMutation)?.sessions).toHaveLength(1);
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

  it('coalesces live token notifications and reconciles only terminal events', () => {
    vi.useFakeTimers();
    try {
      const store = new DashboardLiveStore();
      store.installSnapshot(snapshot('daemon-1', 0));
      store.hydrateSession(sessionResponse(0));
      let notifications = 0;
      const unsubscribe = store.subscribe(() => {
        notifications += 1;
      });
      const message = (
        cursor: number,
        type: 'message.started' | 'message.updated' | 'message.finished',
        content: string,
      ) =>
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
            },
          },
        } as StreamRecord);

      message(1, 'message.started', '');
      message(2, 'message.updated', 'hel');
      message(3, 'message.updated', 'hello');
      expect(notifications).toBe(1);
      expect(store.getSnapshot().cursor).toBe(3);
      expect(
        store.getSnapshot().sessionChangeById['session-1'],
      ).toBeUndefined();

      vi.advanceTimersByTime(32);
      expect(notifications).toBe(2);
      message(4, 'message.finished', 'hello');
      expect(notifications).toBe(3);
      expect(store.getSnapshot().sessionChangeById['session-1']).toBe(1);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
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
    expect(selectSnapshot(store.getSnapshot())?.cursor).toBe(5);
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

  it('assigns stable fallback identities to persisted messages without IDs', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    const projection = store.hydrateSession({
      ...sessionResponse(1),
      entries: [
        {
          type: 'message',
          message: { role: 'user', content: 'Persisted message' },
        },
      ],
    });
    expect(projection?.items['entry-0']).toMatchObject({
      kind: 'message',
      messageId: 'entry-0',
      role: 'user',
      content: 'Persisted message',
    });
  });

  it('installs authoritative history when a live tail arrived first', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
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
          messageId: 'live-answer',
          role: 'assistant',
          content: 'Live answer',
          phase: 'finished',
        },
      },
    } as never);

    const projection = store.hydrateSession({
      ...sessionResponse(2),
      runtimeEpoch: 'epoch-a',
      runtimeSeq: 1,
      entries: [
        {
          type: 'message',
          message: { id: 'history', role: 'user', content: 'Prior history' },
        },
      ],
    });

    expect(projection?.items.history).toBeDefined();
    expect(projection?.items['live-answer']).toBeDefined();
  });

  it('does not duplicate a persisted final message when replaying its live updates', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.hydrateSession(sessionResponse(1));
    for (const [cursor, type, content] of [
      [2, 'message.started', ''],
      [3, 'message.updated', 'Final answer'],
      [4, 'message.finished', 'Final answer'],
    ] as const)
      store.acceptStreamRecord({
        cursor,
        emittedAt: cursor,
        runtimeEpoch: 'epoch-a',
        runtimeSeq: cursor - 1,
        sessionId: 'session-1',
        event: {
          type,
          sessionId: 'session-1',
          message: {
            messageId: 'timestamp:1720000000000',
            role: 'assistant',
            content,
            timestamp: 1720000000000,
            phase: type.split('.')[1],
          },
        },
      } as StreamRecord);

    const projection = store.hydrateSession({
      ...sessionResponse(4),
      runtimeEpoch: 'epoch-a',
      runtimeSeq: 3,
      entries: [
        {
          id: 'persisted-answer',
          type: 'message',
          message: {
            role: 'assistant',
            content: 'Final answer',
            timestamp: 1720000000000,
          },
        },
      ],
    });

    expect(projection?.order).toEqual(['persisted-answer']);
    expect(projection?.items['persisted-answer']).toMatchObject({
      content: 'Final answer',
      status: 'finished',
    });
    expect(projection?.items['timestamp:1720000000000']).toBeUndefined();
  });

  it('removes a delayed live final when HTTP already installed its persisted twin', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 4));
    store.hydrateSession({
      ...sessionResponse(5),
      entries: [
        {
          id: 'persisted-answer',
          type: 'message',
          message: {
            role: 'assistant',
            content: 'Final answer',
            timestamp: 1720000000000,
          },
        },
      ],
    });

    store.acceptStreamRecord({
      cursor: 5,
      emittedAt: 5,
      sessionId: 'session-1',
      event: {
        type: 'message.finished',
        sessionId: 'session-1',
        message: {
          messageId: 'epoch-a:1',
          role: 'assistant',
          content: 'Final answer',
          timestamp: 1720000000000,
          phase: 'finished',
        },
      },
    } as StreamRecord);

    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.order).toEqual(['persisted-answer']);
    expect(projection?.items['epoch-a:1']).toBeUndefined();
  });

  it('does not merge distinct messages that happen to share a timestamp', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 4));
    store.hydrateSession({
      ...sessionResponse(5),
      entries: [
        {
          id: 'persisted-answer',
          type: 'message',
          message: {
            role: 'assistant',
            content: 'Earlier answer',
            timestamp: 1720000000000,
          },
        },
      ],
    });

    store.acceptStreamRecord({
      cursor: 5,
      emittedAt: 5,
      sessionId: 'session-1',
      event: {
        type: 'message.finished',
        sessionId: 'session-1',
        message: {
          messageId: 'epoch-a:2',
          role: 'assistant',
          content: 'Different answer',
          timestamp: 1720000000000,
          phase: 'finished',
        },
      },
    } as StreamRecord);

    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.order).toEqual(['persisted-answer', 'epoch-a:2']);
  });

  it('keeps numeric and string timestamps as distinct message identities', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 4));
    store.hydrateSession({
      ...sessionResponse(5),
      entries: [
        {
          id: 'persisted-answer',
          type: 'message',
          message: {
            role: 'assistant',
            content: 'Same answer',
            timestamp: '1720000000000',
          },
        },
      ],
    });

    store.acceptStreamRecord({
      cursor: 5,
      emittedAt: 5,
      sessionId: 'session-1',
      event: {
        type: 'message.finished',
        sessionId: 'session-1',
        message: {
          messageId: 'epoch-a:typed',
          role: 'assistant',
          content: 'Same answer',
          timestamp: 1720000000000,
          phase: 'finished',
        },
      },
    } as StreamRecord);

    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.order).toEqual(['persisted-answer', 'epoch-a:typed']);
  });

  it('fails open when repeated persisted messages make identity ambiguous', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 4));
    store.hydrateSession({
      ...sessionResponse(5),
      entries: ['first', 'second'].map((id) => ({
        id,
        type: 'message',
        message: {
          role: 'assistant',
          content: 'Repeated answer',
          timestamp: 1720000000000,
        },
      })),
    });

    store.acceptStreamRecord({
      cursor: 5,
      emittedAt: 5,
      sessionId: 'session-1',
      event: {
        type: 'message.finished',
        sessionId: 'session-1',
        message: {
          messageId: 'epoch-a:3',
          role: 'assistant',
          content: 'Repeated answer',
          timestamp: 1720000000000,
          phase: 'finished',
        },
      },
    } as StreamRecord);

    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.order).toEqual(['first', 'second', 'epoch-a:3']);
  });

  it('protects incomplete refreshes but clears an authoritative sparse branch', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.hydrateSession({
      ...sessionResponse(1),
      entries: [
        {
          type: 'message',
          message: { id: 'persisted-prompt', role: 'user', content: 'Prompt' },
        },
      ],
    });

    const incomplete = store.hydrateSession({
      ...sessionResponse(1),
      entriesComplete: false,
      entries: [],
    });
    expect(incomplete?.order).toEqual(['persisted-prompt']);

    const completeSparse = store.hydrateSession({
      ...sessionResponse(1),
      entriesComplete: true,
      entries: [
        { type: 'model_change', provider: 'openai', modelId: 'gpt-5' },
        { type: 'thinking_level_change', thinkingLevel: 'medium' },
      ],
    });
    expect(completeSparse?.items['persisted-prompt']).toBeUndefined();
    expect(completeSparse?.items['entry-0']).toMatchObject({
      kind: 'other',
      raw: { type: 'model_change' },
    });
  });

  it('does not preserve incomplete history across runtime generations', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.hydrateSession({
      ...sessionResponse(1),
      runtimeEpoch: 'epoch-a',
      entries: [
        {
          type: 'message',
          message: { id: 'old-prompt', role: 'user', content: 'Old prompt' },
        },
      ],
    });

    const replacement = store.hydrateSession({
      ...sessionResponse(1),
      runtimeEpoch: 'epoch-b',
      entriesComplete: false,
      entries: [],
    });

    expect(replacement?.runtimeEpoch).toBe('epoch-b');
    expect(replacement?.items['old-prompt']).toBeUndefined();
    expect(replacement?.retiredEpochs).toContain('epoch-a');
  });

  it('restores disk history behind a live-only incomplete refresh baseline', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.hydrateSession({
      ...sessionResponse(1),
      entriesComplete: false,
      entries: [],
    });
    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      sessionId: 'session-1',
      event: {
        type: 'message.finished',
        sessionId: 'session-1',
        message: {
          messageId: 'live-answer',
          role: 'assistant',
          content: 'Live answer',
          phase: 'finished',
        },
      },
    } as never);

    const projection = store.hydrateSession({
      ...sessionResponse(2),
      entriesComplete: false,
      entries: [
        {
          type: 'message',
          message: {
            id: 'first-prompt',
            role: 'user',
            content: 'Original prompt',
          },
        },
      ],
    });

    expect(projection?.order).toEqual(['first-prompt', 'live-answer']);
    expect(projection?.items['first-prompt']).toMatchObject({
      role: 'user',
      content: 'Original prompt',
    });
    expect(projection?.items['live-answer']).toMatchObject({
      role: 'assistant',
      content: 'Live answer',
    });
  });

  it('uses an incomplete initial baseline without replacing the later live projection', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    const initial = store.hydrateSession({
      ...sessionResponse(1),
      entriesComplete: false,
      entries: [
        {
          type: 'message',
          message: { id: 'initial-stale', role: 'user', content: 'Stale' },
        },
      ],
    });
    expect(initial?.items['initial-stale']).toBeDefined();
    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      sessionId: 'session-1',
      event: {
        type: 'message.finished',
        sessionId: 'session-1',
        message: {
          messageId: 'live-answer',
          role: 'assistant',
          content: 'Live answer',
          phase: 'finished',
        },
      },
    } as never);

    const projection = store.hydrateSession({
      ...sessionResponse(2),
      entriesComplete: false,
      entries: [
        {
          type: 'message',
          message: { id: 'stale', role: 'user', content: 'Stale branch' },
        },
      ],
    });

    expect(projection?.items['live-answer']).toBeDefined();
    expect(projection?.items.stale).toBeUndefined();
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

  it('prepends older history, enriches a boundary tool, and keeps live events', () => {
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
          toolCallId: 'live-call',
          name: 'live-tool',
          result: 'live result',
          status: 'completed',
        },
      },
    } as never);
    store.hydrateSession({
      ...sessionResponse(2),
      entries: [
        {
          type: 'message',
          message: {
            role: 'toolResult',
            toolCallId: 'boundary-call',
            content: 'new result',
          },
        },
      ],
    });
    const projection = store.prependSessionHistory({
      ...sessionResponse(2),
      history: { version: 1, start: 10, end: 11, hasOlder: false },
      entries: [
        {
          type: 'tool',
          tool: {
            toolCallId: 'boundary-call',
            name: 'older-tool',
            arguments: { path: '/tmp/file' },
          },
        },
      ],
    });
    expect(projection?.items['boundary-call']).toMatchObject({
      name: 'older-tool',
      arguments: { path: '/tmp/file' },
      result: 'new result',
      status: 'finished',
    });
    expect(projection?.items['live-call']).toMatchObject({
      result: 'live result',
      status: 'finished',
    });
    expect(projection?.order).toEqual(['boundary-call', 'live-call']);
  });

  it('rejects prepending a page without history metadata', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.hydrateSession({ ...sessionResponse(1), entries: [] });
    expect(
      store.prependSessionHistory({ ...sessionResponse(1), entries: [] }),
    ).toBeUndefined();
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

  it('lets an authoritative session read replace a live branch after replay ages out', () => {
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
    expect(projection?.items['new-tail']).toBeUndefined();
    expect(projection?.items['old-tail']).toBeDefined();
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

  it('retries bootstrap immediately when connectivity returns after a snapshot failure', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const store = new DashboardLiveStore();
    let snapshots = 0;
    let streams = 0;
    const client = {
      snapshot: async () => {
        snapshots += 1;
        if (snapshots === 1) throw new Error('offline');
        return snapshot('daemon-1', 200);
      },
      events: async (
        cursor: number,
        _signal: AbortSignal,
        serverId?: string,
      ) => {
        streams += 1;
        expect(cursor).toBe(72);
        expect(serverId).toBe('daemon-1');
        return new Response(
          new ReadableStream<Uint8Array>({ start: () => undefined }),
        );
      },
    } as never;

    const stop = store.connect(client);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshots).toBe(1);
    expect(streams).toBe(0);
    store.reconnect();
    await expect.poll(() => snapshots).toBe(2);
    await expect.poll(() => streams).toBe(1);
    expect(store.getSnapshot().connection.status).toBe('connected');
    stop();
    vi.unstubAllGlobals();
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
