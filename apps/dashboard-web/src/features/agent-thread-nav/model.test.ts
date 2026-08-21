import { describe, expect, it, vi } from 'vitest';
import type { AgentThreadRow } from './model';
import {
  agentThreadRows,
  archivedRowsForShelf,
  boundedAgentThreadRows,
  durableThreadForSession,
  filterAgentThreadRows,
  groupAgentThreadRows,
  hiddenAgentThreadRowCount,
  isArchivedThread,
  isUnavailableThread,
  searchAgentThreadRows,
  sectionAgentThreadRows,
  sessionThreadIdentityKey,
  statusGlyph,
  workspaceGroupIsExpanded,
} from './model';

function row(
  id: string,
  workspaceName: string,
  status: AgentThreadRow['status'] = 'working',
  workspaceId?: string,
): AgentThreadRow {
  return {
    id,
    title: `Thread ${id}`,
    workspaceId,
    workspaceName,
    cwd: `/work/${id}`,
    status,
    startedAt: 0,
    updatedAt: 0,
  };
}

describe('agent thread view model', () => {
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
  });

  it('assigns indexed sessions to a known workspace by cwd when workspaceId is absent', () => {
    const rows = agentThreadRows({
      runtimes: [],
      workspaces: [{ id: 'app', name: 'App', canonicalPath: '/work/app' }],
      sessions: [
        {
          id: 'dormant-session',
          cwd: '/work/app/packages/dashboard',
          updatedAt: 10,
        },
      ],
    } as never);

    expect(rows[0]).toMatchObject({
      id: 'dormant-session',
      workspaceId: 'app',
      workspaceName: 'App',
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
    expect(boundedAgentThreadRows(rows).map(({ id }) => id)).toEqual([
      'pinned',
      'normal',
      'archived',
    ]);
    expect(archivedRowsForShelf([archived], false, 'missing')).toEqual([]);
    expect(archivedRowsForShelf([archived], false, 'archived')).toEqual([
      archived,
    ]);
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

    expect(searchAgentThreadRows(dormant)).toHaveLength(25);
    expect(sectionAgentThreadRows(dormant).active).toHaveLength(25);
    expect(sectionAgentThreadRows(dormant).archived).toEqual([]);
  });

  it('bounds Active rows and reports the next disclosure count', () => {
    const rows = Array.from({ length: 43 }, (_, index) =>
      row(`thread-${index}`, 'Dashboard', index % 2 ? 'dormant' : 'working'),
    );

    const visible = boundedAgentThreadRows(rows, 40);
    expect(visible).toHaveLength(40);
    expect(visible.every((item) => item.status !== 'offline')).toBe(true);
    expect(hiddenAgentThreadRowCount(rows, visible)).toBe(3);
  });

  it('keeps the selected dormant thread visible past the Active bound', () => {
    const dormant = Array.from({ length: 3 }, (_, index) =>
      row(`old-${index}`, 'Dashboard', 'dormant'),
    );

    expect(
      boundedAgentThreadRows(dormant, 1, 'old-2').map(({ id }) => id),
    ).toEqual(['old-0', 'old-2']);
  });

  it('keeps collapsed groups closed unless actively searching', () => {
    expect(workspaceGroupIsExpanded(true, false)).toBe(false);
    expect(workspaceGroupIsExpanded(true, true)).toBe(true);
    expect(workspaceGroupIsExpanded(false, false)).toBe(true);
  });

  it('groups rows by workspace identity and names other workspaces separately', () => {
    const rows = [
      row('one', 'Dashboard', 'working', 'workspace-1'),
      row('two', 'Dashboard', 'offline', 'workspace-1'),
      row('three', 'External'),
      row('four', 'External'),
    ];

    expect(groupAgentThreadRows(rows)).toEqual([
      [
        'workspace-1',
        {
          workspaceId: 'workspace-1',
          workspaceName: 'Dashboard',
          rows: [rows[0], rows[1]],
        },
      ],
      [
        'other:External',
        { workspaceName: 'External', rows: [rows[2], rows[3]] },
      ],
    ]);
  });
});
