import type {
  BrowserSnapshot,
  SessionApiResponse,
} from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_REQUEST_ORDER } from './http-client.js';
import {
  DashboardLiveStore,
  selectRuntimeForSession,
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

function orderedResponse(
  response: SessionApiResponse,
  order: number,
): SessionApiResponse {
  Object.defineProperty(response, SESSION_REQUEST_ORDER, { value: order });
  return response;
}

describe('DashboardLiveStore', () => {
  it('rejects a stale same-generation latest response before it regresses live state', () => {
    const store = new DashboardLiveStore();
    const runtime = {
      runtimeId: 'runtime-1',
      online: true,
      liveState: 'working',
      session: { id: 'session-1', entries: [] },
      pendingInteractions: [],
      extensionSurfaces: [],
    } as never;
    store.installSnapshot({
      ...snapshot('daemon-1', 4),
      runtimes: [runtime],
      sessions: [
        { ...sessionResponse(4).metadata, activeRuntimeId: 'runtime-1' },
      ],
    });
    const latest = (messageId: string, order: number) => {
      const response = {
        ...sessionResponse(4),
        metadata: {
          ...sessionResponse(4).metadata,
          activeRuntimeId: 'runtime-1',
        },
        entriesComplete: true,
        active: {
          runtimeId: 'runtime-1',
          pendingInteractions: [],
          messages: [{ messageId, role: 'assistant', content: messageId }],
          tools: [
            {
              toolCallId: `${messageId}-tool`,
              name: 'read',
              status: 'running',
            },
          ],
          delegates: [
            {
              runId: `${messageId}-delegate`,
              lineageId: 'lineage-1',
              name: 'worker',
              kind: 'background',
              state: 'running',
              createdAt: 1,
              allowWrites: false,
              transcript: [],
            },
          ],
          truncated: false,
        },
        completeThroughCursor: true,
      } as SessionApiResponse;
      Object.defineProperty(response, SESSION_REQUEST_ORDER, { value: order });
      return response;
    };

    store.hydrateSession(latest('response-a', 1));
    store.hydrateSession(latest('response-b', 2));
    expect(store.hydrateSession(latest('response-a', 1))).toBeUndefined();

    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.order).toEqual(['response-b', 'response-b-tool']);
    expect(projection?.items['response-a']).toBeUndefined();
    const projectedRuntime = store.getSnapshot().runtimesById['runtime-1'];
    expect(projectedRuntime?.extensionSurfaces?.[0]?.viewModel).toMatchObject({
      statuses: [{ runId: 'response-b-delegate' }],
    });
  });

  it('does not poison ordering from invalid higher-order responses', () => {
    const wrongServerStore = new DashboardLiveStore();
    wrongServerStore.installSnapshot(snapshot('daemon-1', 4));
    expect(
      wrongServerStore.hydrateSession(
        orderedResponse(
          { ...sessionResponse(4, 'daemon-2'), entriesComplete: true },
          2,
        ),
      ),
    ).toBeUndefined();
    expect(
      wrongServerStore.hydrateSession(
        orderedResponse({ ...sessionResponse(4), entriesComplete: true }, 1),
      ),
    ).toBeDefined();

    const uncoveredStore = new DashboardLiveStore();
    uncoveredStore.installSnapshot(snapshot('daemon-1', 4));
    expect(
      uncoveredStore.hydrateSession(
        orderedResponse({ ...sessionResponse(1), entriesComplete: true }, 2),
      ),
    ).toBeUndefined();
    expect(
      uncoveredStore.hydrateSession(
        orderedResponse({ ...sessionResponse(4), entriesComplete: true }, 1),
      ),
    ).toBeDefined();
  });

  it('accepts an idempotent replay of the same latest request order', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 4));
    const response = orderedResponse(
      {
        ...sessionResponse(4),
        entriesComplete: true,
        entries: [
          {
            type: 'message',
            id: 'accepted-message',
            message: { role: 'assistant', content: 'accepted' },
          },
        ],
      },
      1,
    );
    const first = store.hydrateSession(response);
    const replay = store.hydrateSession(response);
    expect(first).toBeDefined();
    expect(replay?.order).toEqual(['accepted-message']);
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1']?.order,
    ).toEqual(['accepted-message']);
  });

  it('hydrates active messages and tools through the canonical projection without duplicate terminal rows', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 4));
    store.hydrateSession({
      ...sessionResponse(4),
      entriesComplete: true,
      entries: [
        {
          type: 'message',
          id: 'assistant-1',
          message: { role: 'assistant', content: 'persisted answer' },
        },
      ],
      active: {
        pendingInteractions: [],
        messages: [
          {
            messageId: 'assistant-1',
            role: 'assistant',
            content: 'persisted answer',
          },
          {
            messageId: 'assistant-live',
            role: 'assistant',
            content: 'streaming answer',
          },
        ],
        tools: [
          {
            toolCallId: 'tool-live',
            name: 'search',
            status: 'running',
          },
        ],
        delegates: [],
        truncated: false,
      },
      completeThroughCursor: false,
    } as SessionApiResponse);

    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.order).toEqual([
      'assistant-1',
      'assistant-live',
      'tool-live',
    ]);
    expect(projection?.items['assistant-live']).toMatchObject({
      kind: 'message',
      status: 'streaming',
    });
    expect(projection?.items['tool-live']).toMatchObject({
      kind: 'tool',
      status: 'running',
    });
  });

  it('applies compaction completion as a transcript delta', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.hydrateSession({
      ...sessionResponse(1),
      entries: [
        {
          type: 'message',
          id: 'prompt-1',
          message: { role: 'user', content: 'Keep this message.' },
        },
      ],
    });

    expect(
      store.acceptStreamRecord({
        cursor: 2,
        emittedAt: 2,
        sessionId: 'session-1',
        event: {
          type: 'session.compacted',
          sessionId: 'session-1',
          entry: {
            type: 'compaction',
            id: 'compact-1',
            summary: 'Earlier work.',
          },
        },
      }),
    ).toBe(true);
    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.order).toEqual(['prompt-1', 'compact-1']);
    expect(projection?.items['compact-1']).toMatchObject({
      kind: 'other',
      raw: { type: 'compaction', summary: 'Earlier work.' },
    });
  });

  it('preserves indexed chronology when hydrating an active runtime session', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      sessions: [
        {
          id: 'session-1',
          file: '/tmp/session.jsonl',
          cwd: '/tmp',
          startedAt: 10,
          updatedAt: 20,
          activeRuntimeId: 'runtime-1',
        },
      ],
    });

    store.hydrateSession({
      ...sessionResponse(2),
      metadata: {
        id: 'session-1',
        file: '/tmp/session.jsonl',
        cwd: '/tmp',
        updatedAt: 999,
        activeRuntimeId: 'runtime-1',
      },
    });

    expect(store.getSnapshot().sessionsById['session-1']).toMatchObject({
      startedAt: 10,
      updatedAt: 20,
      activeRuntimeId: 'runtime-1',
    });
  });

  it('authoritatively replaces sessions without clearing transcripts and handles replay ordering', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      sessions: [
        { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
        { id: 'removed', file: '', cwd: '/tmp', updatedAt: 1 },
      ],
    } as unknown as BrowserSnapshot);
    store.hydrateSession(sessionResponse(1));
    const beforeNonce = store.getSnapshot().resyncNonce;

    expect(
      store.acceptStreamRecord({
        type: 'sessions',
        cursor: 2,
        emittedAt: 2,
        upsert: [
          {
            id: 'session-1',
            file: '/tmp/session.jsonl',
            cwd: '/tmp',
            updatedAt: 2,
          },
          { id: 'new-session', file: '', cwd: '/tmp', updatedAt: 2 },
        ],
        remove: ['removed'],
      }),
    ).toBe(true);
    expect(store.getSnapshot().sessionsById).toEqual({
      'session-1': {
        id: 'session-1',
        file: '/tmp/session.jsonl',
        cwd: '/tmp',
        updatedAt: 2,
      },
      'new-session': { id: 'new-session', file: '', cwd: '/tmp', updatedAt: 2 },
    });
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1'],
    ).toBeDefined();
    expect(store.getSnapshot().cursor).toBe(2);
    expect(store.getSnapshot().cursorHistory).toContain(2);
    expect(store.getSnapshot().resyncNonce).toBe(beforeNonce);
    expect(
      store.acceptStreamRecord({
        type: 'sessions',
        cursor: 2,
        emittedAt: 3,
        upsert: [],
        remove: [],
      }),
    ).toBe(false);
    expect(
      store.acceptStreamRecord({
        type: 'sessions',
        cursor: 4,
        emittedAt: 4,
        upsert: [],
        remove: [],
      }),
    ).toBe(false);
  });

  it('does not resync hydrated transcripts for repeated session metadata records', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [
        {
          runtimeId: 'runtime-1',
          online: true,
          session: { id: 'session-1', entries: [] },
        },
      ],
      sessions: [
        {
          id: 'session-1',
          file: '',
          cwd: '/tmp',
          updatedAt: 1,
          activeRuntimeId: 'runtime-1',
        },
      ],
    } as unknown as BrowserSnapshot);
    store.hydrateSession(sessionResponse(1));

    for (let cursor = 2; cursor <= 101; cursor += 1) {
      expect(
        store.acceptStreamRecord({
          type: 'sessions',
          cursor,
          emittedAt: cursor,
          upsert: [
            {
              id: 'session-1',
              file: '/tmp/session.jsonl',
              cwd: '/tmp',
              updatedAt: cursor,
              activeRuntimeId: 'runtime-1',
            },
          ],
          remove: [],
        }),
      ).toBe(true);
    }

    expect(store.getSnapshot().sessionsById['session-1']?.updatedAt).toBe(101);
    expect(store.getSnapshot().cursor).toBe(101);
    expect(store.getSnapshot().resyncNonce).toBe(0);
    expect(store.getSnapshot().sessionChangeById['session-1']).toBeUndefined();
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1'],
    ).toBeDefined();
  });

  it('scopes dormant transcript metadata changes to the changed session', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      sessions: [
        { id: 'session-1', file: '/tmp/one.jsonl', cwd: '/tmp', updatedAt: 1 },
        { id: 'session-2', file: '/tmp/two.jsonl', cwd: '/tmp', updatedAt: 1 },
      ],
    } as unknown as BrowserSnapshot);
    store.hydrateSession({
      ...sessionResponse(1),
      metadata: {
        id: 'session-1',
        file: '/tmp/one.jsonl',
        cwd: '/tmp',
        updatedAt: 1,
        entryCount: 1,
      },
    });

    store.acceptStreamRecord({
      type: 'sessions',
      cursor: 2,
      emittedAt: 2,
      upsert: [
        {
          id: 'session-1',
          file: '/tmp/one.jsonl',
          cwd: '/tmp',
          updatedAt: 2,
          entryCount: 2,
        },
        {
          id: 'session-2',
          file: '/tmp/two.jsonl',
          cwd: '/tmp',
          updatedAt: 2,
        },
      ],
      remove: [],
    });

    expect(store.getSnapshot().sessionChangeById).toEqual({
      'session-1': 1,
      'session-2': 1,
    });
  });

  it('preserves optimistic titles across authoritative session-index records', () => {
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
      type: 'sessions',
      cursor: 4,
      emittedAt: 4,
      upsert: [metadata],
      remove: [],
    });
    expect(store.getSnapshot().sessionsById['session-1']?.title).toBe(
      'first request',
    );
    store.acceptStreamRecord({
      cursor: 5,
      emittedAt: 5,
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

  it('carries a launched runtime title into its first published session', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));

    expect(
      store.optimisticallyTitleRuntime(
        'runtime-1',
        '<skill name="review" location="/skills/review/SKILL.md">\nFollow these instructions.\n</skill>\n\nInspect the title flow',
      ),
    ).toBe(true);
    expect(store.getSnapshot().optimisticRuntimeTitlesById['runtime-1']).toBe(
      '[skill] review Inspect the title flow',
    );

    store.installSnapshot({
      ...snapshot('daemon-1', 2),
      runtimes: [
        {
          runtimeId: 'runtime-1',
          liveState: 'working',
          pendingInteractions: [],
          extensionSurfaces: [],
          session: { id: 'session-1', entries: [] },
        },
      ],
      sessions: [
        {
          id: 'session-1',
          file: '',
          cwd: '/tmp',
          updatedAt: 2,
        },
      ],
    } as unknown as BrowserSnapshot);

    expect(store.getSnapshot().runtimesById['runtime-1']?.session.title).toBe(
      '[skill] review Inspect the title flow',
    );
    expect(store.getSnapshot().sessionsById['session-1']?.title).toBe(
      '[skill] review Inspect the title flow',
    );
    expect(
      store.getSnapshot().optimisticRuntimeTitlesById['runtime-1'],
    ).toBeUndefined();

    store.acceptStreamRecord({
      cursor: 3,
      emittedAt: 3,
      runtimeId: 'runtime-1',
      event: {
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: { pendingInteractions: [] },
      },
    } as unknown as StreamRecord);
    expect(store.getSnapshot().optimisticSessionTitlesById['session-1']).toBe(
      '[skill] review Inspect the title flow',
    );

    // A later server snapshot without persisted metadata must not regress the
    // visible runtime title while the first message is still being written.
    store.installSnapshot({
      ...snapshot('daemon-1', 4),
      runtimes: [
        {
          runtimeId: 'runtime-1',
          liveState: 'working',
          pendingInteractions: [],
          extensionSurfaces: [],
          session: { id: 'session-1', entries: [] },
        },
      ],
      sessions: [
        {
          id: 'session-1',
          file: '',
          cwd: '/tmp',
          updatedAt: 4,
        },
      ],
    } as unknown as BrowserSnapshot);
    expect(store.getSnapshot().runtimesById['runtime-1']?.session.title).toBe(
      '[skill] review Inspect the title flow',
    );
  });

  it('titles TUI sessions from live user messages and indexed metadata', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [
        {
          runtimeId: 'runtime-1',
          liveState: 'idle',
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
      sessionId: 'session-1',
      event: {
        type: 'message.started',
        sessionId: 'session-1',
        message: {
          messageId: 'user-1',
          role: 'user',
          content: '  Created from the TUI  ',
        },
      },
    } as StreamRecord);
    expect(store.getSnapshot().runtimesById['runtime-1']?.session.title).toBe(
      'Created from the TUI',
    );

    store.installSnapshot({
      ...snapshot('daemon-1', 3),
      runtimes: [
        {
          runtimeId: 'runtime-1',
          liveState: 'working',
          pendingInteractions: [],
          extensionSurfaces: [],
          session: { id: 'session-1', entries: [] },
        },
      ],
      sessions: [
        {
          id: 'session-1',
          file: '/tmp/session.jsonl',
          cwd: '/tmp',
          updatedAt: 3,
          title: 'Indexed TUI title',
        },
      ],
    } as unknown as BrowserSnapshot);
    expect(store.getSnapshot().runtimesById['runtime-1']?.session.title).toBe(
      'Indexed TUI title',
    );

    store.acceptStreamRecord({
      cursor: 4,
      emittedAt: 4,
      runtimeId: 'runtime-1',
      event: {
        type: 'runtime.stateChanged',
        state: 'idle',
        snapshot: { pendingInteractions: [] },
      },
    } as unknown as StreamRecord);
    expect(store.getSnapshot().runtimesById['runtime-1']?.session.title).toBe(
      'Indexed TUI title',
    );
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

  it('applies lifecycle deltas without replacing the runtime shell', () => {
    const store = new DashboardLiveStore();
    const runtime = {
      runtimeId: 'runtime-1',
      ownership: 'external',
      pid: 10,
      cwd: '/tmp/old',
      liveState: 'idle',
      online: true,
      pendingInteractions: [],
      session: {
        id: 'session-1',
        entries: [{ type: 'message', id: 'existing' }],
      },
    };
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [runtime],
      sessions: [
        {
          id: 'session-1',
          file: '',
          cwd: '/tmp',
          updatedAt: 1,
          activeRuntimeId: 'runtime-1',
        },
      ],
    } as unknown as BrowserSnapshot);
    store.hydrateSession({
      ...sessionResponse(1),
      entries: [
        {
          id: 'persisted-message',
          type: 'message',
          message: { role: 'user', content: 'preserve me' },
        },
      ],
    } as never);

    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      runtimeId: 'runtime-1',
      runtimeEpoch: 'epoch-a',
      runtimeSeq: 2,
      sessionId: 'session-1',
      event: {
        type: 'runtime.stateChanged',
        state: 'idle',
        snapshot: { online: false, lastSeenAt: 2 },
      },
    } as StreamRecord);
    expect(store.getSnapshot().runtimesById['runtime-1']).toMatchObject({
      runtimeId: 'runtime-1',
      online: false,
      session: { id: 'session-1', entries: [{ id: 'existing' }] },
    });
    expect(
      store.getSnapshot().sessionsById['session-1']?.activeRuntimeId,
    ).toBeUndefined();
    store.acceptStreamRecord({
      cursor: 3,
      emittedAt: 3,
      runtimeId: 'runtime-1',
      runtimeEpoch: 'epoch-b',
      runtimeSeq: 1,
      sessionId: 'session-1',
      event: {
        type: 'runtime.hello',
        protocolVersion: 1,
        snapshot: {
          ...runtime,
          cwd: '/tmp/new',
          liveState: 'working',
          online: true,
          session: { id: 'session-1', entries: [], entriesComplete: false },
        },
      },
    } as StreamRecord);
    expect(store.getSnapshot().runtimesById['runtime-1']).toMatchObject({
      runtimeId: 'runtime-1',
      cwd: '/tmp/new',
      liveState: 'working',
      online: true,
      session: { id: 'session-1', entries: [], entriesComplete: false },
    });
    expect(store.getSnapshot().sessionChangeById['session-1']).toBe(1);
    expect(store.getSnapshot().sessionsById['session-1']?.activeRuntimeId).toBe(
      'runtime-1',
    );
    expect(
      store.getSnapshot().sessionReplacementBySessionId['session-1'],
    ).toBeUndefined();
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1']?.items[
        'persisted-message'
      ],
    ).toBeDefined();

    // Late frames from the retired epoch still advance the global cursor, but
    // cannot undo the authoritative reconnect or trigger lifecycle effects.
    store.acceptStreamRecord({
      cursor: 4,
      emittedAt: 4,
      runtimeId: 'runtime-1',
      runtimeEpoch: 'epoch-a',
      runtimeSeq: 99,
      sessionId: 'session-1',
      event: {
        type: 'runtime.stateChanged',
        state: 'idle',
        snapshot: { online: false },
      },
    } as StreamRecord);
    store.acceptStreamRecord({
      cursor: 5,
      emittedAt: 5,
      runtimeId: 'runtime-1',
      runtimeEpoch: 'epoch-a',
      runtimeSeq: 100,
      sessionId: 'session-2',
      event: {
        type: 'runtime.hello',
        protocolVersion: 1,
        snapshot: {
          ...runtime,
          cwd: '/tmp/stale',
          session: { id: 'session-2', entries: [], entriesComplete: false },
        },
      },
    } as StreamRecord);
    expect(store.getSnapshot().cursor).toBe(5);
    expect(store.getSnapshot().runtimesById['runtime-1']).toMatchObject({
      cwd: '/tmp/new',
      online: true,
      session: { id: 'session-1' },
    });
    expect(store.getSnapshot().sessionsById['session-1']?.activeRuntimeId).toBe(
      'runtime-1',
    );
    expect(store.getSnapshot().sessionChangeById['session-1']).toBe(1);
    expect(store.getSnapshot().sessionReplacementByRuntimeId['runtime-1']).toBe(
      'session-1',
    );
    expect(
      store.getSnapshot().sessionReplacementBySessionId['session-2'],
    ).toBeUndefined();
  });

  it('selects the active runtime before preferring online over offline matches', () => {
    const store = new DashboardLiveStore();
    const oldRuntime = {
      runtimeId: 'runtime-old',
      online: false,
      liveState: 'idle',
      pendingInteractions: [],
      session: { id: 'session-1', entries: [] },
    };
    const newRuntime = {
      runtimeId: 'runtime-new',
      online: true,
      liveState: 'working',
      pendingInteractions: [],
      session: { id: 'session-1', entries: [] },
    };
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [oldRuntime, newRuntime],
      sessions: [
        {
          id: 'session-1',
          file: '',
          cwd: '/tmp',
          updatedAt: 1,
          activeRuntimeId: 'runtime-new',
        },
      ],
    } as unknown as BrowserSnapshot);
    expect(selectRuntimeForSession('session-1')(store.getSnapshot())).toBe(
      store.getSnapshot().runtimesById['runtime-new'],
    );
    store.installSnapshot({
      ...snapshot('daemon-1', 2),
      runtimes: [oldRuntime, newRuntime],
      sessions: [{ id: 'session-1', file: '', cwd: '/tmp', updatedAt: 2 }],
    } as unknown as BrowserSnapshot);
    expect(selectRuntimeForSession('session-1')(store.getSnapshot())).toBe(
      store.getSnapshot().runtimesById['runtime-new'],
    );
  });

  it('maps a reconnect session replacement without navigating same-session reconnects', () => {
    const store = new DashboardLiveStore();
    const runtime = {
      runtimeId: 'runtime-1',
      ownership: 'external',
      pid: 10,
      cwd: '/tmp',
      liveState: 'idle',
      online: false,
      pendingInteractions: [],
      session: { id: 'session-1', entries: [] },
    };
    store.installSnapshot({
      ...snapshot('daemon-1', 1),
      runtimes: [runtime],
      sessions: [
        { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
        { id: 'session-2', file: '', cwd: '/tmp', updatedAt: 1 },
      ],
    } as unknown as BrowserSnapshot);
    store.acceptStreamRecord({
      cursor: 2,
      emittedAt: 2,
      runtimeId: 'runtime-1',
      runtimeEpoch: 'epoch-new',
      runtimeSeq: 1,
      sessionId: 'session-2',
      event: {
        type: 'runtime.hello',
        protocolVersion: 1,
        snapshot: {
          ...runtime,
          online: true,
          session: { id: 'session-2', entries: [], entriesComplete: false },
        },
      },
    } as StreamRecord);
    expect(store.getSnapshot().sessionReplacementByRuntimeId['runtime-1']).toBe(
      'session-2',
    );
    expect(store.getSnapshot().sessionReplacementBySessionId['session-1']).toBe(
      'session-2',
    );
    expect(store.getSnapshot().sessionsById['session-1']?.activeRuntimeId).toBe(
      undefined,
    );
    expect(store.getSnapshot().sessionsById['session-2']?.activeRuntimeId).toBe(
      'runtime-1',
    );
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
    expect(store.acceptStreamRecord(envelope(7))).toBe(false);
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
      expect(
        store.getSnapshot().sessionChangeById['session-1'],
      ).toBeUndefined();
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

  it('reuses unchanged transcript items across identical and append-only recovery', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    const entries = [
      {
        type: 'message',
        id: 'entry-a',
        message: { role: 'user', content: 'first' },
      },
      {
        type: 'message',
        id: 'entry-b',
        message: { role: 'assistant', content: 'answer' },
      },
    ];
    const initial = store.hydrateSession({
      ...sessionResponse(1),
      entries,
    });
    const firstItem = initial?.items['entry-a'];
    const secondItem = initial?.items['entry-b'];
    const identical = store.hydrateSession({
      ...sessionResponse(2),
      entries,
    });
    expect(identical?.order).toEqual(['entry-a', 'entry-b']);
    expect(identical?.items['entry-a']).toBe(firstItem);
    expect(identical?.items['entry-b']).toBe(secondItem);
    const appended = store.hydrateSession({
      ...sessionResponse(3),
      entries: [
        ...entries,
        {
          type: 'message',
          id: 'entry-c',
          message: { role: 'user', content: 'continue' },
        },
      ],
    });
    expect(appended?.order).toEqual(['entry-a', 'entry-b', 'entry-c']);
    expect(appended?.items['entry-a']).toBe(firstItem);
    expect(appended?.items['entry-b']).toBe(secondItem);
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

  it('invalidates compact session snapshots while runtime state changes stay local', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));

    expect(
      store.acceptStreamRecord({
        cursor: 2,
        emittedAt: 2,
        runtimeId: 'runtime-1',
        event: {
          type: 'runtime.stateChanged',
          state: 'working',
          snapshot: {
            session: {
              id: 'session-1',
              entries: [],
              entriesComplete: false,
            },
          },
        },
      } as never),
    ).toBe(true);
    expect(store.getSnapshot().sessionChangeById['session-1']).toBeUndefined();

    expect(
      store.acceptStreamRecord({
        cursor: 3,
        emittedAt: 3,
        event: {
          type: 'session.snapshot',
          session: {
            id: 'session-1',
            entries: [],
            entriesComplete: false,
          },
        },
      } as never),
    ).toBe(true);
    expect(store.getSnapshot().sessionChangeById['session-1']).toBe(1);
  });

  it('does not recover for terminal granular events', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    for (const [cursor, event] of [
      [
        2,
        {
          type: 'tool.finished',
          sessionId: 'session-1',
          tool: {
            toolCallId: 'call-1',
            name: 'read',
            result: 'done',
            status: 'completed',
          },
        },
      ],
      [3, { type: 'agent.settled', sessionId: 'session-1' }],
      [
        4,
        {
          type: 'message.finished',
          sessionId: 'session-1',
          message: {
            messageId: 'message-1',
            role: 'assistant',
            content: 'done',
          },
        },
      ],
    ] as const)
      expect(
        store.acceptStreamRecord({
          cursor,
          emittedAt: cursor,
          sessionId: 'session-1',
          event,
        } as never),
      ).toBe(true);
    expect(store.getSnapshot().sessionChangeById['session-1']).toBeUndefined();
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
