import { describe, expect, it } from 'vitest';
import type { AgentThreadRow } from './model';
import {
  boundedAgentThreadRows,
  filterAgentThreadRows,
  groupAgentThreadRows,
  hiddenAgentThreadRowCount,
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
