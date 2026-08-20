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
  historyRowsForShelf,
  isArchivedThread,
  isHistoryThread,
  searchAgentThreadRows,
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
    expect(first).toBe('session-a\nsession-b\nsession-live');
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

  it('keeps archived rows out of active/history and puts pinned rows first', () => {
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
    expect(isHistoryThread(archived)).toBe(false);
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

  it('partitions dormant and offline rows into history', () => {
    expect(isHistoryThread(row('live', 'Dashboard', 'idle'))).toBe(false);
    expect(isHistoryThread(row('offline', 'Dashboard', 'offline'))).toBe(true);
    expect(isHistoryThread(row('dormant', 'Dashboard', 'dormant'))).toBe(true);
  });

  it('shows all matching history rows while searching', () => {
    const history = Array.from({ length: 25 }, (_, index) =>
      row(`old-${index}`, 'Dashboard', 'dormant'),
    );

    expect(searchAgentThreadRows(history)).toHaveLength(25);
  });

  it('keeps only the selected history row as a collapsed-shelf exception', () => {
    const history = [
      row('old-1', 'Dashboard', 'dormant'),
      row('old-2', 'Dashboard', 'offline'),
    ];

    expect(historyRowsForShelf(history, false, 'old-2')).toEqual([history[1]]);
    expect(historyRowsForShelf(history, false, 'missing')).toEqual([]);
    expect(historyRowsForShelf(history, true, 'old-2')).toEqual(history);
  });

  it('bounds active and history rows independently', () => {
    const active = Array.from({ length: 41 }, (_, index) =>
      row(`active-${index}`, 'Dashboard'),
    );
    const history = [
      row('old-1', 'Dashboard', 'dormant'),
      row('old-2', 'Dashboard', 'offline'),
      row('old-3', 'Dashboard', 'dormant'),
    ];

    const visible = boundedAgentThreadRows([...active, ...history], 2);
    expect(visible).toHaveLength(42);
    expect(visible.slice(0, 40).map(({ id }) => id)).toEqual(
      active.slice(0, 40).map(({ id }) => id),
    );
    expect(visible.slice(40).map(({ id }) => id)).toEqual(['old-1', 'old-2']);
    expect(hiddenAgentThreadRowCount([...active, ...history], visible)).toBe(1);
  });

  it('keeps the selected dormant thread visible past the history bound', () => {
    const history = Array.from({ length: 3 }, (_, index) =>
      row(`old-${index}`, 'Dashboard', 'dormant'),
    );

    expect(
      boundedAgentThreadRows(history, 1, 'old-2').map(({ id }) => id),
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
