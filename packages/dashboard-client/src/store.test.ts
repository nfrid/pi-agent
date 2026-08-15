import type {
  AuthoritativeSessionSnapshot,
  BrowserSnapshot,
  ShellFeedEvent,
  ShellProjection,
} from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_REQUEST_ORDER } from './http-client.js';
import {
  DashboardLiveStore,
  selectRuntimeForSession,
  selectSnapshot,
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

type StreamRecord = Parameters<DashboardLiveStore['applyEventEnvelope']>[0];

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
): AuthoritativeSessionSnapshot =>
  ({
    serverId,
    cursor,
    metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: cursor },
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
  }) as AuthoritativeSessionSnapshot;

function orderedResponse(
  response: AuthoritativeSessionSnapshot,
  order: number,
): AuthoritativeSessionSnapshot {
  Object.defineProperty(response, SESSION_REQUEST_ORDER, { value: order });
  return response;
}

describe('DashboardLiveStore', () => {
  it('converges near-capacity catalogue patches with a fresh shell snapshot', () => {
    const projection: ShellProjection = {
      truncated: true,
      omitted: [
        'workspaces',
        'projects',
        'checkouts',
        'threads',
        'runs',
        'unread',
      ],
    };
    const workspaces = [{ id: 'workspace-kept' }];
    const projects = [{ id: 'project-kept' }];
    const checkouts = [{ id: 'checkout-kept' }];
    const threads = [{ id: 'thread-kept' }];
    const runs = [{ id: 'run-kept' }];
    const unread = [{ id: 'notification-kept' }];
    const fresh = {
      ...snapshot('daemon-1', 4),
      workspaces,
      projects,
      checkouts,
      threads,
      runs,
      unread,
      shellProjection: projection,
    } as unknown as BrowserSnapshot;
    const store = new DashboardLiveStore();
    store.beginShellSync(1);
    expect(store.acceptShellSnapshot(fresh, 0, 1, true)).toBe(true);
    const events = [
      {
        sequence: 1,
        revision: 1,
        domain: 'workspace' as const,
        data: { workspaces, shellProjection: projection },
      },
      {
        sequence: 2,
        revision: 2,
        domain: 'orchestration' as const,
        data: {
          projects,
          checkouts,
          threads,
          runs,
          shellProjection: projection,
        },
      },
      {
        sequence: 3,
        revision: 3,
        domain: 'notification' as const,
        data: { unread, shellProjection: projection },
      },
      {
        sequence: 4,
        revision: 4,
        domain: 'usage' as const,
        data: { shellProjection: projection },
      },
    ] as unknown as ShellFeedEvent[];
    for (const event of events)
      expect(store.acceptShellEvent(event, 1)).toBe(true);
    const patched = selectSnapshot(store.getSnapshot());
    expect(patched?.workspaces).toEqual(fresh.workspaces);
    expect(patched?.projects).toEqual(fresh.projects);
    expect(patched?.checkouts).toEqual(fresh.checkouts);
    expect(patched?.threads).toEqual(fresh.threads);
    expect(patched?.runs).toEqual(fresh.runs);
    expect(patched?.unread).toEqual(fresh.unread);
    expect(patched?.shellProjection).toEqual(fresh.shellProjection);
  });

  it('replaces the complete session index without retaining stale rows', () => {
    const store = new DashboardLiveStore();
    const first = {
      id: 'session-first',
      file: '',
      cwd: '/tmp',
      updatedAt: 1,
    };
    const stale = {
      id: 'session-stale',
      file: '',
      cwd: '/tmp',
      updatedAt: 1,
    };
    const runtime = {
      runtimeId: 'runtime-first',
      ownership: 'external',
      pid: 1,
      cwd: '/tmp',
      liveState: 'idle',
      session: { id: first.id, name: 'Old name', entries: [] },
      pendingInteractions: [],
    } as const;
    store.beginShellSync(1);
    expect(
      store.acceptShellSnapshot(
        {
          ...snapshot('daemon-1', 0),
          runtimes: [runtime],
          sessions: [{ ...first, name: 'Old name' }, stale],
        },
        0,
        1,
        true,
      ),
    ).toBe(true);
    const replacement = {
      type: 'shell-event',
      sequence: 1,
      revision: 1,
      domain: 'session-index',
      data: {
        kind: 'replace',
        sessions: [first],
      },
    } satisfies ShellFeedEvent;
    expect(store.acceptShellEvent(replacement, 1)).toBe(true);
    expect(Object.keys(store.getSnapshot().sessionsById)).toEqual([
      'session-first',
    ]);
    expect(
      store.getSnapshot().runtimesById['runtime-first']?.session.name,
    ).toBeUndefined();
  });

  it('keeps replacement thread metadata and ordering through an ordered shell transition', () => {
    const store = new DashboardLiveStore();
    const existing = {
      id: 'existing-session',
      file: '',
      cwd: '/tmp',
      startedAt: 100,
      updatedAt: 100,
    };
    const replacement = {
      id: 'replacement-session',
      file: '',
      cwd: '/tmp',
      name: 'Replacement session',
      startedAt: 200,
      updatedAt: 200,
    };
    store.beginShellSync(1);
    expect(
      store.acceptShellSnapshot(
        {
          ...snapshot('daemon-1', 0),
          runtimes: [
            {
              runtimeId: 'runtime-1',
              liveState: 'working',
              pendingInteractions: [],
              session: { id: existing.id, entries: [] },
            } as never,
          ],
          sessions: [existing],
        },
        0,
        1,
        true,
      ),
    ).toBe(true);

    expect(
      store.acceptShellEvent(
        {
          type: 'shell-event',
          sequence: 1,
          revision: 1,
          domain: 'session-index',
          data: { kind: 'delta', upsert: [replacement], remove: [] },
        },
        1,
      ),
    ).toBe(true);
    const afterMetadata = selectSnapshot(store.getSnapshot());
    expect(afterMetadata?.sessions.map((session) => session.id)).toEqual([
      'existing-session',
      'replacement-session',
    ]);
    expect(afterMetadata?.sessions[1]).toMatchObject({
      id: 'replacement-session',
      name: 'Replacement session',
      startedAt: 200,
    });

    expect(
      store.acceptShellEvent(
        {
          type: 'shell-event',
          sequence: 2,
          revision: 2,
          domain: 'runtime',
          data: {
            kind: 'upsert',
            runtime: {
              runtimeId: 'runtime-1',
              liveState: 'working',
              pendingInteractions: [],
              session: { id: 'replacement-session', entries: [] },
            },
          },
        } as unknown as ShellFeedEvent,
        1,
      ),
    ).toBe(true);
    const afterRuntime = selectSnapshot(store.getSnapshot());
    expect(afterRuntime?.sessions.map((session) => session.id)).toEqual([
      'existing-session',
      'replacement-session',
    ]);
    expect(afterRuntime?.sessions[1]?.startedAt).toBe(200);
    expect(
      store.getSnapshot().runtimesById['runtime-1']?.session,
    ).toMatchObject({
      id: 'replacement-session',
      name: 'Replacement session',
    });
  });

  it('converges an offline runtime patch with its authoritative snapshot', () => {
    const store = new DashboardLiveStore();
    const online = {
      runtimeId: 'runtime-offline',
      ownership: 'external',
      pid: 1,
      cwd: '/tmp',
      liveState: 'idle',
      online: true,
      lastSeenAt: 1,
      session: { id: 'session-offline', entries: [] },
      pendingInteractions: [],
    } as const;
    const offline = { ...online, online: false, lastSeenAt: 2 };
    store.beginShellSync(1);
    expect(
      store.acceptShellSnapshot(
        { ...snapshot('daemon-1', 0), runtimes: [online] },
        0,
        1,
        true,
      ),
    ).toBe(true);
    const patch = {
      type: 'shell-event',
      sequence: 1,
      revision: 1,
      domain: 'runtime',
      data: { kind: 'upsert', runtime: offline },
    } as unknown as ShellFeedEvent;
    expect(store.acceptShellEvent(patch, 1)).toBe(true);
    const patched = store.getSnapshot().runtimesById['runtime-offline'];
    const snapshotStore = new DashboardLiveStore();
    snapshotStore.beginShellSync(1);
    expect(
      snapshotStore.acceptShellSnapshot(
        { ...snapshot('daemon-1', 1), runtimes: [offline] },
        1,
        1,
        true,
      ),
    ).toBe(true);
    expect(patched).toEqual(
      snapshotStore.getSnapshot().runtimesById['runtime-offline'],
    );
  });

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
      } as AuthoritativeSessionSnapshot;
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

  it('keeps latest request ordering through a structural response clone', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    const current = {
      ...sessionResponse(1),
      entries: [
        {
          type: 'message',
          id: 'current-message',
          message: { role: 'assistant', content: 'current' },
        },
      ],
      [SESSION_REQUEST_ORDER]: 2,
    } as AuthoritativeSessionSnapshot;
    const stale = structuredClone({
      ...current,
      entries: [
        {
          type: 'message',
          id: 'stale-message',
          message: { role: 'assistant', content: 'stale' },
        },
      ],
      [SESSION_REQUEST_ORDER]: 1,
    }) as AuthoritativeSessionSnapshot;

    expect(store.hydrateSession(current)).toBeDefined();
    expect(store.hydrateSession(stale)).toBeUndefined();
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1']?.items[
        'current-message'
      ],
    ).toBeDefined();
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1']?.items[
        'stale-message'
      ],
    ).toBeUndefined();
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
    ).toBeDefined();
    expect(
      uncoveredStore.hydrateSession(
        orderedResponse({ ...sessionResponse(4), entriesComplete: true }, 1),
      ),
    ).toBeUndefined();
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
    } as AuthoritativeSessionSnapshot);

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
      store.applyEventEnvelope({
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

    store.applyEventEnvelope({
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

    store.applyEventEnvelope({
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

    store.applyEventEnvelope({
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

    store.applyEventEnvelope({
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

    store.applyEventEnvelope({
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
    store.applyEventEnvelope({
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
    store.applyEventEnvelope({
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
    store.applyEventEnvelope({
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
    store.applyEventEnvelope({
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

    store.applyEventEnvelope(runtimeEvent(2, 'epoch-a', 1, 'working'));
    store.applyEventEnvelope(runtimeEvent(3, 'epoch-b', 1, 'waiting'));
    expect(
      store.applyEventEnvelope(runtimeEvent(4, 'epoch-a', 99, 'idle')),
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
    store.applyEventEnvelope({
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
    store.applyEventEnvelope({
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

    store.applyEventEnvelope({
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

    store.applyEventEnvelope({
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

  it('accepts complete authoritative mutation snapshots with active provenance', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.applyMutationResult({
      ...sessionResponse(2),
      runtimeEpoch: 'mutation-epoch',
      runtimeSeq: 7,
      active: {
        ...sessionResponse(2).active,
        messages: [
          {
            messageId: 'mutation-message',
            role: 'assistant',
            content: 'from mutation',
          },
        ],
        tools: [
          {
            toolCallId: 'mutation-tool',
            name: 'read',
            status: 'running' as const,
          },
        ],
      },
    });

    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.items['mutation-message']).toMatchObject({
      kind: 'message',
      content: 'from mutation',
    });
    expect(projection?.items['mutation-tool']).toMatchObject({
      kind: 'tool',
      status: 'running',
    });
    expect(projection).toMatchObject({
      lastCursor: 2,
      runtimeEpoch: 'mutation-epoch',
      lastRuntimeSeq: 7,
    });
  });

  it('ignores legacy-shaped mutation session data at the authoritative ingress', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));

    store.applyMutationResult({
      serverId: 'daemon-1',
      cursor: 2,
      metadata: {
        id: 'session-1',
        file: '',
        cwd: '/tmp',
        updatedAt: 2,
        title: 'legacy response',
      },
      entries: [],
      entriesComplete: true,
    });

    expect(store.getSnapshot().sessionsById['session-1']).toBeUndefined();
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1'],
    ).toBeUndefined();
  });

  it('rejects gaps without retaining global browser event history', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 4));
    store.applyEventEnvelope(envelope(5));
    expect(store.applyEventEnvelope(envelope(7))).toBe(false);
    store.applyEventEnvelope(envelope(6));
    expect(store.getSnapshot().cursor).toBe(6);
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
        store.applyEventEnvelope({
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
  });

  it('hydrates a finite response without replaying removed global records', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 3));
    store.applyEventEnvelope(envelope(4));
    store.applyEventEnvelope(envelope(5));
    const projection = store.hydrateSession(sessionResponse(3));
    expect(projection?.sessionId).toBe('session-1');
    expect(projection?.lastCursor).toBe(3);
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

  it('does not duplicate a persisted final message when replaying its live updates', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.hydrateSession(sessionResponse(1));
    for (const [cursor, type, content] of [
      [2, 'message.started', ''],
      [3, 'message.updated', 'Final answer'],
      [4, 'message.finished', 'Final answer'],
    ] as const)
      store.applyEventEnvelope({
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

    store.applyEventEnvelope({
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
    store.applyEventEnvelope({
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
    store.applyEventEnvelope({
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

  it('retains the oldest loaded history cursor with the cached projection', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.beginSessionSync('session-1', 1);
    store.acceptSessionSnapshot(
      {
        ...sessionResponse(1),
        entries: [
          {
            type: 'message',
            id: 'newer-message',
            message: { role: 'assistant', content: 'same content' },
          },
        ],
        history: {
          version: 1,
          start: 10,
          end: 20,
          hasOlder: true,
          nextBefore: 'older-page',
        },
      },
      1,
      1,
      true,
    );
    expect(
      store.prependSessionHistory({
        ...sessionResponse(1),
        entries: [
          {
            type: 'message',
            id: 'older-message',
            message: { role: 'assistant', content: 'same content' },
          },
        ],
        history: {
          version: 1,
          start: 0,
          end: 10,
          hasOlder: false,
        },
      }),
    ).toBeDefined();

    expect(
      store.getSnapshot().sessionSnapshotsById['session-1']?.history,
    ).toEqual({ version: 1, start: 0, end: 10, hasOlder: false });
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1']?.order,
    ).toEqual(expect.arrayContaining(['older-message', 'newer-message']));
    expect(
      store.acceptSessionEvent(
        'session-1',
        2,
        {
          event: {
            type: 'message.finished',
            sessionId: 'session-1',
            message: {
              messageId: 'live-message',
              role: 'assistant',
              content: 'same content',
            },
          },
        },
        1,
      ),
    ).toBe(true);
    expect(
      store.getSnapshot().transcriptsBySessionId['session-1']?.order,
    ).toEqual(
      expect.arrayContaining([
        'older-message',
        'newer-message',
        'live-message',
      ]),
    );
    expect(store.markSessionCached('session-1', 1, 2, true)).toBe(true);
    expect(store.getSnapshot().sessionSyncById['session-1']?.status).toBe(
      'cached',
    );
  });

  it('merges historical pages without replacing the authoritative active overlay', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    const authoritative = {
      ...sessionResponse(1),
      entries: [
        {
          type: 'message',
          id: 'newer-message',
          message: { role: 'assistant', content: 'newer' },
        },
      ],
      active: {
        ...sessionResponse(1).active,
        messages: [
          { messageId: 'active-message', role: 'assistant', content: 'live' },
        ],
        tools: [
          {
            toolCallId: 'active-tool',
            name: 'read',
            status: 'running' as const,
          },
        ],
      },
    };
    expect(store.acceptSessionSnapshot(authoritative, 1, 1, true)).toBe(true);

    expect(
      store.prependSessionHistory({
        ...sessionResponse(1),
        entries: [
          {
            type: 'message',
            id: 'older-message',
            message: { role: 'assistant', content: 'older' },
          },
        ],
        history: { version: 1, start: 0, end: 1, hasOlder: false },
        active: {
          ...sessionResponse(1).active,
          messages: [],
          tools: [],
        },
      }),
    ).toBeDefined();

    expect(
      store.getSnapshot().transcriptsBySessionId['session-1']?.order,
    ).toEqual([
      'older-message',
      'newer-message',
      'active-message',
      'active-tool',
    ]);
    expect(
      store.getSnapshot().sessionSnapshotsById['session-1']?.active,
    ).toMatchObject({
      messages: [{ messageId: 'active-message' }],
      tools: [{ toolCallId: 'active-tool' }],
    });
  });

  it('rejects prepending a page without history metadata', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.hydrateSession({ ...sessionResponse(1), entries: [] });
    expect(
      store.prependSessionHistory({
        ...sessionResponse(1),
        entries: [],
        history: undefined,
      }),
    ).toBeUndefined();
  });

  it('invalidates compact session snapshots while runtime state changes stay local', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));

    expect(
      store.applyEventEnvelope({
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
      store.applyEventEnvelope({
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
        store.applyEventEnvelope({
          cursor,
          emittedAt: cursor,
          sessionId: 'session-1',
          event,
        } as never),
      ).toBe(true);
    expect(store.getSnapshot().sessionChangeById['session-1']).toBeUndefined();
  });

  it('attributes reconnect hydration to the response runtime epoch', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    expect(
      store.acceptSessionSnapshot(
        {
          ...sessionResponse(1),
          runtimeEpoch: 'epoch-a',
          runtimeSeq: 0,
          entries: [
            {
              type: 'message',
              message: { id: 'history-a', role: 'user', content: 'before' },
            },
          ],
        },
        1,
        0,
        true,
      ),
    ).toBe(true);
    store.acceptSessionEvent(
      'session-1',
      2,
      {
        runtimeEpoch: 'epoch-a',
        runtimeSeq: 1,
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
      },
      0,
    );
    expect(
      store.acceptSessionSnapshot(
        {
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
        },
        3,
        0,
        true,
      ),
    ).toBe(true);
    const hydrated = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(hydrated?.runtimeEpoch).toBe('epoch-b');
    expect(hydrated?.retiredEpochs).toContain('epoch-a');
    const next = store.acceptSessionEvent(
      'session-1',
      4,
      {
        runtimeEpoch: 'epoch-b',
        runtimeSeq: 1,
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
      },
      0,
    );
    expect(next).toBe(true);
    const projection = store.getSnapshot().transcriptsBySessionId['session-1'];
    expect(projection?.items['history-a']).toBeDefined();
    expect(projection?.items['answer-a']).toBeDefined();
    expect(projection?.items['answer-b']).toBeDefined();
  });

  it('lets an authoritative session read replace a live branch after replay ages out', () => {
    const store = new DashboardLiveStore();
    store.installSnapshot(snapshot('daemon-1', 1));
    store.applyEventEnvelope({
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
      store.applyEventEnvelope(envelope(cursor, 'session-2'));

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
    store.applyEventEnvelope({
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
