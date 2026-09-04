import { describe, expect, it, vi } from 'vitest';
import { draftPath } from '../drafts';
import type { AgentThreadRow } from './model';
import {
  agentThreadRows,
  bulkThreadActions,
  canSettleThread,
  durableThreadForSession,
  filterAgentThreadRows,
  hiddenAgentThreadRowCount,
  isArchivedThread,
  isUnavailableThread,
  resolvedDraftPromotionIds,
  sectionAgentThreadRows,
  sessionThreadIdentityKey,
  statusGlyph,
} from './model';

function row(
  id: string,
  projectName: string,
  status: AgentThreadRow['status'] = 'working',
  projectId?: string,
): AgentThreadRow {
  return {
    id,
    title: `Thread ${id}`,
    projectId,
    projectName,
    cwd: `/work/${id}`,
    status,
    startedAt: 0,
    updatedAt: 0,
  };
}

describe('agent thread view model', () => {
  it('includes drafts in project-scoped navigation rows without runtime state', () => {
    const rows = agentThreadRows(
      {
        runtimes: [],
        sessions: [],
        runs: [],
        projects: [
          { id: 'project-1', title: 'Project One', rootPath: '/work/one' },
        ],
      } as never,
      undefined,
      [],
      [
        {
          id: 'draft-1',
          projectId: 'project-1',
          createdAt: 1,
          updatedAt: 2,
          isolation: 'worktree',
        },
      ],
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        id: 'draft-1',
        projectId: 'project-1',
        projectName: 'Project One',
        status: 'draft',
        statusLabel: 'draft',
        draft: expect.anything(),
      }),
    );
    expect(draftPath(rows.find((row) => row.draft)?.id ?? '')).toBe(
      '/drafts/draft-1',
    );
  });

  it('shows a promoted draft as starting while its run is active', () => {
    const rows = agentThreadRows(
      {
        runtimes: [],
        sessions: [],
        runs: [{ threadId: 'thread-1', status: 'starting' }],
        projects: [
          { id: 'project-1', title: 'Project One', rootPath: '/work/one' },
        ],
      } as never,
      undefined,
      [],
      [
        {
          id: 'draft-1',
          projectId: 'project-1',
          createdAt: 1,
          updatedAt: 2,
          isolation: 'worktree',
          promotedThreadId: 'thread-1',
        },
      ],
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({ status: 'waiting', statusLabel: 'starting' }),
    );
  });

  it('replaces a promoted draft with its runtime-backed session row', () => {
    const draft = {
      id: 'draft-1',
      projectId: 'project-1',
      createdAt: 1,
      updatedAt: 20,
      isolation: 'worktree' as const,
      promotedThreadId: 'thread-1',
    };
    const snapshot = {
      runtimes: [
        {
          runtimeId: 'runtime-1',
          liveState: 'working',
          cwd: '/work/one',
          session: { id: 'session-1', title: 'Started thread', entries: [] },
        },
      ],
      sessions: [],
      runs: [
        {
          threadId: 'thread-1',
          runtimeId: 'runtime-1',
          status: 'running',
        },
      ],
      projects: [
        { id: 'project-1', title: 'Project One', rootPath: '/work/one' },
      ],
    } as never;

    expect(agentThreadRows(snapshot, undefined, [], [draft])).toEqual([
      expect.objectContaining({
        id: 'session-1',
        title: 'Started thread',
        startedAt: 20,
        updatedAt: 20,
      }),
    ]);
  });

  it('promotes through indexed active runtime identity before the runtime snapshot arrives', () => {
    const draft = {
      id: 'draft-1',
      projectId: 'project-1',
      createdAt: 1,
      updatedAt: 20,
      isolation: 'worktree' as const,
      promotedThreadId: 'thread-1',
    };
    const snapshot = {
      runtimes: [],
      sessions: [
        {
          id: 'session-1',
          cwd: '/work/one',
          activeRuntimeId: 'runtime-1',
          startedAt: 21,
        },
      ],
      runs: [
        {
          threadId: 'thread-1',
          runtimeId: 'runtime-1',
          status: 'running',
        },
      ],
      projects: [
        { id: 'project-1', title: 'Project One', rootPath: '/work/one' },
      ],
    } as never;

    expect(agentThreadRows(snapshot, undefined, [], [draft])).toEqual([
      expect.objectContaining({ id: 'session-1', startedAt: 21 }),
    ]);
    expect(resolvedDraftPromotionIds(snapshot, [], [draft])).toEqual([
      'draft-1',
    ]);
    expect(sessionThreadIdentityKey(snapshot)).toBe('');
  });

  it('cleans up promotion metadata only after indexed chronology arrives', () => {
    const draft = {
      id: 'draft-1',
      projectId: 'project-1',
      createdAt: 1,
      updatedAt: 20,
      isolation: 'worktree' as const,
      promotedThreadId: 'thread-1',
    };
    const snapshot = (startedAt?: number) =>
      ({
        runs: [
          {
            threadId: 'thread-1',
            runtimeId: 'runtime-1',
            status: 'running',
          },
        ],
        runtimes: [{ runtimeId: 'runtime-1', session: { id: 'session-1' } }],
        sessions: [
          {
            id: 'session-1',
            ...(startedAt === undefined ? {} : { startedAt }),
          },
        ],
      }) as never;

    expect(resolvedDraftPromotionIds(snapshot(), [], [draft])).toEqual([]);
    expect(resolvedDraftPromotionIds(snapshot(19), [], [draft])).toEqual([
      'draft-1',
    ]);
  });

  it('keys persisted-link refreshes to the exact session identity set', () => {
    const first = sessionThreadIdentityKey({
      sessions: [{ id: 'session-b' }, { id: 'session-a' }],
      runtimes: [{ session: { id: 'session-live' } }],
    } as never);
    expect(first).toBe(
      'indexed:session-a\nindexed:session-b\nruntime:session-live',
    );
    expect(
      sessionThreadIdentityKey({
        sessions: [{ id: 'session-a' }, { id: 'session-b' }],
        runtimes: [{ session: { id: 'session-live' } }],
      } as never),
    ).toBe(first);
    expect(
      sessionThreadIdentityKey({
        sessions: [
          { id: 'session-a' },
          { id: 'session-b' },
          { id: 'session-new' },
        ],
        runtimes: [{ session: { id: 'session-live' } }],
      } as never),
    ).not.toBe(first);
    expect(
      sessionThreadIdentityKey({
        sessions: [
          { id: 'session-a' },
          { id: 'session-b' },
          { id: 'session-live' },
        ],
        runtimes: [{ session: { id: 'session-live' } }],
      } as never),
    ).not.toBe(first);
    expect(
      sessionThreadIdentityKey({
        sessions: [{ id: 'session-a' }, { id: 'session-b' }],
        runtimes: [
          { runtimeId: 'runtime-new', session: { id: 'session-new' } },
        ],
        runs: [{ runtimeId: 'runtime-new', threadId: 'thread-new' }],
      } as never),
    ).toBe('indexed:session-a\nindexed:session-b');
  });

  it('keeps nested delegate sessions out of top-level thread navigation', () => {
    const snapshot = {
      runtimes: [],
      sessions: [
        { id: 'parent', cwd: '/work/app', updatedAt: 1 },
        {
          id: 'child',
          cwd: '/work/app',
          updatedAt: 2,
          sessionKind: 'delegate',
          parentSessionId: 'parent',
        },
      ],
      runs: [],
    } as never;

    expect(agentThreadRows(snapshot).map((entry) => entry.id)).toEqual([
      'parent',
    ]);
    expect(sessionThreadIdentityKey(snapshot)).toBe('indexed:parent');
  });

  it('uses the server-owned project association for indexed sessions', () => {
    const rows = agentThreadRows({
      runtimes: [],
      projects: [{ id: 'app', title: 'App', status: 'active' }],
      sessions: [
        {
          id: 'dormant-session',
          cwd: '/work/app/packages/dashboard',
          projectId: 'app',
          updatedAt: 10,
        },
      ],
    } as never);

    expect(rows[0]).toMatchObject({
      id: 'dormant-session',
      projectId: 'app',
      projectName: 'App',
      status: 'dormant',
    });
  });

  it('keeps unindexed runtime chronology stable across live surface updates', () => {
    const snapshot = (surface: unknown) =>
      ({
        runtimes: [
          {
            runtimeId: 'runtime-1',
            liveState: 'working',
            online: true,
            cwd: '/work/app',
            session: { id: 'session-1', title: 'Active thread', entries: [] },
            extensionSurfaces: [surface],
          },
          {
            runtimeId: 'runtime-2',
            liveState: 'working',
            online: true,
            cwd: '/work/app',
            session: { id: 'session-2', title: 'Other thread', entries: [] },
          },
        ],
        workspaces: [{ id: 'app', name: 'App', canonicalPath: '/work/app' }],
        sessions: [],
      }) as never;

    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValueOnce(100).mockReturnValueOnce(200);
    const first = agentThreadRows(
      snapshot({ statuses: [{ state: 'running' }] }),
    );
    const second = agentThreadRows(
      snapshot({ statuses: [{ state: 'finished', finishedAt: 200 }] }),
    );
    clock.mockRestore();

    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(
      second.map(({ startedAt, updatedAt }) => [startedAt, updatedAt]),
    ).toEqual(first.map(({ startedAt, updatedAt }) => [startedAt, updatedAt]));
  });

  it('sorts solely by creation timestamp regardless of runtime status', () => {
    const rows = agentThreadRows({
      runtimes: [
        {
          runtimeId: 'runtime-working',
          liveState: 'working',
          online: true,
          cwd: '/work/app',
          session: { id: 'working', entries: [] },
        },
      ],
      sessions: [
        {
          id: 'working',
          cwd: '/work/app',
          startedAt: 10,
          updatedAt: 30,
        },
        {
          id: 'newer-dormant',
          cwd: '/work/app',
          startedAt: 20,
          updatedAt: 20,
        },
      ],
    } as never);

    expect(rows.map(({ id }) => id)).toEqual(['newer-dormant', 'working']);
  });

  it('lets indexed chronology replace the neutral runtime fallback', () => {
    const runtime = {
      runtimeId: 'runtime-1',
      liveState: 'working',
      online: true,
      cwd: '/work/app',
      session: { id: 'session-1', title: 'Active thread', entries: [] },
    };
    const base = {
      runtimes: [runtime],
      workspaces: [{ id: 'app', name: 'App', canonicalPath: '/work/app' }],
      sessions: [],
    };
    const before = agentThreadRows(base as never)[0];
    const after = agentThreadRows({
      ...base,
      sessions: [
        {
          id: 'session-1',
          cwd: '/work/app',
          startedAt: 100,
          updatedAt: 200,
        },
      ],
    } as never)[0];

    expect(before).toMatchObject({
      startedAt: undefined,
      updatedAt: undefined,
    });
    expect(after).toMatchObject({ startedAt: 100, updatedAt: 200 });
  });

  it('joins durable metadata only through an unambiguous persisted run mapping', () => {
    const snapshot = {
      runs: [
        { piSessionId: 'session-1', threadId: 'thread-1', status: 'running' },
        { piSessionId: 'session-2', threadId: 'thread-2', status: 'completed' },
        { piSessionId: 'session-2', threadId: 'thread-3', status: 'completed' },
      ],
    } as never;
    const threads = [
      { id: 'thread-1', archivedAt: 10, pinnedAt: 20 },
      { id: 'thread-2' },
      { id: 'thread-3' },
    ];

    expect(durableThreadForSession(snapshot, 'session-1', threads)).toEqual({
      threadId: 'thread-1',
      archivedAt: 10,
      pinnedAt: 20,
      hasActiveRun: true,
    });
    expect(
      durableThreadForSession(snapshot, 'session-2', threads),
    ).toBeUndefined();
    expect(
      durableThreadForSession(snapshot, 'missing', threads),
    ).toBeUndefined();
    expect(
      durableThreadForSession(
        {
          runs: [
            {
              piSessionId: 'session-1',
              threadId: 'missing',
              status: 'completed',
            },
          ],
        } as never,
        'session-1',
        threads,
      ),
    ).toBeUndefined();
  });

  it('retains the durable run model for immediate card metadata fallback', () => {
    const snapshot = {
      runs: [
        {
          piSessionId: 'session-1',
          threadId: 'thread-1',
          status: 'running',
          model: {
            provider: 'openai-codex',
            model: 'gpt-test',
            serviceTier: 'fast',
          },
        },
      ],
    } as never;

    expect(
      durableThreadForSession(snapshot, 'session-1', [
        { id: 'thread-1' },
      ]),
    ).toMatchObject({
      threadId: 'thread-1',
      model: {
        provider: 'openai-codex',
        model: 'gpt-test',
        serviceTier: 'fast',
      },
    });
  });

  it('prefers live snapshot lifecycle metadata over a stale finite-query fallback', () => {
    const snapshot = {
      runtimes: [
        {
          runtimeId: 'runtime-live',
          liveState: 'working',
          online: true,
          cwd: '/work/app',
          session: { id: 'session-live', entries: [] },
        },
      ],
      sessions: [],
      runs: [
        {
          piSessionId: 'session-live',
          threadId: 'thread-live',
          status: 'running',
        },
      ],
      threads: [
        {
          id: 'thread-live',
          archivedAt: 20,
          pinnedAt: 30,
          settledAt: 40,
        },
      ],
    } as never;

    const rows = agentThreadRows(snapshot, [{ id: 'thread-live' }] as never);

    expect(rows[0]?.durableThread).toEqual({
      threadId: 'thread-live',
      archivedAt: 20,
      pinnedAt: 30,
      settledAt: 40,
      hasActiveRun: true,
    });
  });

  it('uses exact links, rejects conflicting run identities, and treats online runtimes as active', () => {
    const snapshot = {
      runs: [
        {
          piSessionId: 'linked-session',
          threadId: 'thread-linked',
          status: 'completed',
        },
        {
          piSessionId: 'conflict-session',
          threadId: 'thread-old',
          status: 'completed',
        },
      ],
      runtimes: [
        {
          runtimeId: 'runtime-linked',
          online: true,
          liveState: 'working',
          cwd: '/work/app',
          session: { id: 'linked-session', entries: [] },
        },
      ],
    } as never;
    const links = [
      {
        sessionId: 'linked-session',
        threadId: 'thread-linked',
        archivedAt: 10,
        pinnedAt: 20,
      },
      {
        sessionId: 'conflict-session',
        threadId: 'thread-new',
      },
    ];
    expect(
      durableThreadForSession(snapshot, 'linked-session', [], links),
    ).toEqual({
      threadId: 'thread-linked',
      archivedAt: 10,
      pinnedAt: 20,
      hasActiveRun: true,
    });
    expect(
      durableThreadForSession(snapshot, 'conflict-session', [], links),
    ).toBeUndefined();
  });

  it('partitions pinned rows globally before active and archived', () => {
    const pinnedDormant = {
      ...row('pinned-dormant', 'Other', 'dormant'),
      durableThread: {
        threadId: 'thread-pinned-dormant',
        pinnedAt: 30,
        hasActiveRun: false,
      },
    };
    const sections = sectionAgentThreadRows([
      row('active', 'Dashboard'),
      pinnedDormant,
      row('history', 'Dashboard', 'offline'),
      {
        ...row('archived', 'Other'),
        durableThread: {
          threadId: 'thread-archived',
          archivedAt: 20,
          hasActiveRun: false,
        },
      },
    ]);
    expect(sections.pinned.map(({ id }) => id)).toEqual(['pinned-dormant']);
    expect(sections.active.map(({ id }) => id)).toEqual(['active', 'history']);
    expect(sections.archived.map(({ id }) => id)).toEqual(['archived']);
  });

  it('gives archived and pinned rows precedence over Settled and Active', () => {
    const archived = {
      ...row('archived-settled', 'Dashboard'),
      durableThread: {
        threadId: 'thread-archived-settled',
        archivedAt: 30,
        settledAt: 20,
        hasActiveRun: false,
      },
    };
    const pinnedSettled = {
      ...row('pinned-settled', 'Dashboard'),
      durableThread: {
        threadId: 'thread-pinned-settled',
        pinnedAt: 10,
        settledAt: 20,
        hasActiveRun: false,
      },
    };
    const settled = {
      ...row('settled', 'Dashboard'),
      durableThread: {
        threadId: 'thread-settled',
        settledAt: 20,
        hasActiveRun: false,
      },
    };
    const active = row('active', 'Dashboard');
    const sections = sectionAgentThreadRows(
      [archived, pinnedSettled, settled, active],
      1,
    );
    expect(sections.archived.map(({ id }) => id)).toEqual(['archived-settled']);
    expect(sections.pinned.map(({ id }) => id)).toEqual(['pinned-settled']);
    expect(sections.settled.map(({ id }) => id)).toEqual(['settled']);
    expect(sections.active.map(({ id }) => id)).toEqual(['active']);
    expect(
      hiddenAgentThreadRowCount(
        [archived, pinnedSettled, settled, active],
        sections.active,
      ),
    ).toBe(0);
  });

  it('keeps archived rows out of active and puts pinned rows first', () => {
    const pinned = {
      ...row('pinned', 'Dashboard'),
      durableThread: {
        threadId: 'thread-pinned',
        pinnedAt: 10,
        hasActiveRun: false,
      },
    };
    const archived = {
      ...row('archived', 'Dashboard', 'dormant'),
      durableThread: {
        threadId: 'thread-archived',
        archivedAt: 20,
        hasActiveRun: false,
      },
    };
    const rows = [row('normal', 'Dashboard'), pinned, archived];

    expect(isArchivedThread(archived)).toBe(true);
    const sections = sectionAgentThreadRows(rows);
    expect(sections.pinned.map(({ id }) => id)).toEqual(['pinned']);
    expect(sections.active.map(({ id }) => id)).toEqual(['normal']);
    expect(sections.archived.map(({ id }) => id)).toEqual(['archived']);
  });

  it('offers quick settle only for durable finished threads', () => {
    const durable = {
      threadId: 'thread-1',
      hasActiveRun: false,
    };
    expect(
      canSettleThread({
        ...row('idle', 'Dashboard', 'idle'),
        durableThread: durable,
      }),
    ).toBe(true);
    expect(
      canSettleThread({
        ...row('failed', 'Dashboard', 'failed'),
        durableThread: durable,
      }),
    ).toBe(true);
    expect(
      canSettleThread({
        ...row('dormant', 'Dashboard', 'dormant'),
        durableThread: durable,
      }),
    ).toBe(true);
    expect(
      canSettleThread({
        ...row('working', 'Dashboard'),
        durableThread: durable,
      }),
    ).toBe(false);
    expect(
      canSettleThread({
        ...row('waiting', 'Dashboard', 'waiting'),
        durableThread: durable,
      }),
    ).toBe(false);
    expect(
      canSettleThread({
        ...row('settled', 'Dashboard', 'idle'),
        durableThread: { ...durable, settledAt: 10 },
      }),
    ).toBe(false);
  });

  it('offers only lifecycle actions shared by every selected thread', () => {
    const durable = (id: string, settledAt?: number): AgentThreadRow => ({
      ...row(id, 'Dashboard', 'dormant'),
      durableThread: {
        threadId: id,
        hasActiveRun: false,
        ...(settledAt === undefined ? {} : { settledAt }),
      },
    });
    const settled = [durable('one', 1), durable('two', 2)];

    expect(bulkThreadActions(settled)).toEqual(['pin', 'unsettle', 'archive']);
    expect(
      bulkThreadActions([
        settled[0],
        {
          ...settled[1],
          durableThread: {
            threadId: 'two',
            settledAt: 2,
            hasActiveRun: true,
          },
        },
      ]),
    ).toEqual(['pin', 'unsettle']);
    expect(bulkThreadActions([settled[0], row('draft', 'Dashboard')])).toEqual(
      [],
    );
  });

  it('uses compact distinct glyphs for passive waiting and input', () => {
    expect(statusGlyph('waiting')).toBe('◐');
    expect(statusGlyph('input')).toBe('◆');
  });

  it('filters by title, workspace, path, or status', () => {
    const rows = [
      row('backend', 'Dashboard'),
      row('frontend', 'Other', 'offline'),
    ];

    expect(filterAgentThreadRows(rows, ' dashboard ')).toEqual([rows[0]]);
    expect(filterAgentThreadRows(rows, '/work/frontend')).toEqual([rows[1]]);
    expect(filterAgentThreadRows(rows, 'offline')).toEqual([rows[1]]);
    expect(filterAgentThreadRows(rows, '   ')).toEqual(rows);
  });

  it('classifies dormant and offline availability without a lifecycle shelf', () => {
    expect(isUnavailableThread(row('live', 'Dashboard', 'idle'))).toBe(false);
    expect(isUnavailableThread(row('offline', 'Dashboard', 'offline'))).toBe(
      true,
    );
    expect(isUnavailableThread(row('dormant', 'Dashboard', 'dormant'))).toBe(
      true,
    );
  });

  it('shows all matching dormant rows while searching', () => {
    const dormant = Array.from({ length: 25 }, (_, index) =>
      row(`old-${index}`, 'Dashboard', 'dormant'),
    );

    expect(
      sectionAgentThreadRows(dormant, Number.POSITIVE_INFINITY).active,
    ).toHaveLength(25);
    expect(sectionAgentThreadRows(dormant).archived).toEqual([]);
  });

  it('bounds Active rows and reports the next disclosure count', () => {
    const rows = Array.from({ length: 43 }, (_, index) =>
      row(`thread-${index}`, 'Dashboard', index % 2 ? 'dormant' : 'working'),
    );

    const visible = sectionAgentThreadRows(rows, 40).active;
    expect(visible).toHaveLength(40);
    expect(visible.every((item) => item.status !== 'offline')).toBe(true);
    expect(hiddenAgentThreadRowCount(rows, visible)).toBe(3);
  });

  it('keeps the selected draft visible past the Active bound', () => {
    const drafts = Array.from({ length: 3 }, (_, index) =>
      row(`draft-${index}`, 'Dashboard', 'draft'),
    );
    expect(
      sectionAgentThreadRows(drafts, 1, 'draft-2').active.map(({ id }) => id),
    ).toEqual(['draft-0', 'draft-2']);
  });

  it('keeps the selected dormant thread visible past the Active bound', () => {
    const dormant = Array.from({ length: 3 }, (_, index) =>
      row(`old-${index}`, 'Dashboard', 'dormant'),
    );

    expect(
      sectionAgentThreadRows(dormant, 1, 'old-2').active.map(({ id }) => id),
    ).toEqual(['old-0', 'old-2']);
  });
});
