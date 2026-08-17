import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { workspaceForPath } from '@pi-dashboard/protocol';
import { sessionDisplayTitle } from '../../app-helpers';
import { dashboardStatus } from '../presentation-status';

export type AgentThreadRow = {
  id: string;
  title: string;
  workspaceId?: string;
  workspaceName: string;
  cwd: string;
  status:
    | RuntimeSnapshot['liveState']
    | 'paused'
    | 'offline'
    | 'dormant'
    | 'input';
  statusLabel?: string;
  runtime?: RuntimeSnapshot;
  session?: SessionIndexEntry;
  startedAt?: number;
  updatedAt?: number;
};

export type AgentThreadGroup = {
  workspaceId?: string;
  workspaceName: string;
  rows: AgentThreadRow[];
};

export const MAX_VISIBLE_ACTIVE_THREADS = 40;
export const MAX_VISIBLE_HISTORY_THREADS = 24;

// Runtime snapshots are live overlays, not session-index metadata. Keep their
// chronology neutral until the authoritative index publishes a real timestamp.
function isInactiveThread(row: AgentThreadRow): boolean {
  return row.status === 'offline' || row.status === 'dormant';
}

export function agentThreadRows(snapshot: BrowserSnapshot): AgentThreadRow[] {
  const workspaces = snapshot.workspaces;
  const sessionsById = new Map(
    snapshot.sessions.map((session) => [session.id, session]),
  );
  const rows = new Map<string, AgentThreadRow>();
  for (const runtime of snapshot.runtimes) {
    const session = sessionsById.get(runtime.session.id);
    const workspace = workspaceForPath(runtime.cwd, workspaces);
    const presentation = dashboardStatus(runtime);
    rows.set(runtime.session.id, {
      id: runtime.session.id,
      title: sessionDisplayTitle(runtime.session, runtime.session.entries),
      workspaceId: session?.workspaceId ?? workspace?.id,
      workspaceName: workspace?.name ?? 'Other workspace',
      cwd: runtime.cwd,
      status: presentation.status,
      statusLabel: presentation.label,
      runtime,
      session,
      startedAt: session?.startedAt,
      updatedAt: session?.updatedAt,
    });
  }
  for (const session of snapshot.sessions) {
    if (rows.has(session.id)) continue;
    const workspace = workspaces.find(
      (item) => item.id === session.workspaceId,
    );
    rows.set(session.id, {
      id: session.id,
      title: sessionDisplayTitle(session),
      workspaceId: session.workspaceId,
      workspaceName: workspace?.name ?? 'Other workspace',
      cwd: session.cwd,
      status: 'dormant',
      session,
      startedAt: session.startedAt ?? 0,
      updatedAt: session.updatedAt,
    });
  }
  return [...rows.values()].sort(
    (left, right) =>
      inactiveRank(left.status) - inactiveRank(right.status) ||
      activeUnindexedRank(left) - activeUnindexedRank(right) ||
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      left.title.localeCompare(right.title),
  );
}

function inactiveRank(status: AgentThreadRow['status']): number {
  return status === 'offline' || status === 'dormant' ? 1 : 0;
}

function activeUnindexedRank(row: AgentThreadRow): number {
  return !isInactiveThread(row) && row.session?.startedAt === undefined
    ? -1
    : 0;
}

export function filterAgentThreadRows(
  rows: readonly AgentThreadRow[],
  query: string,
): AgentThreadRow[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? rows.filter((row) =>
        `${row.title} ${row.workspaceName} ${row.cwd} ${row.status}`
          .toLowerCase()
          .includes(needle),
      )
    : [...rows];
}

export function boundedAgentThreadRows(
  rows: readonly AgentThreadRow[],
  historyLimit = MAX_VISIBLE_HISTORY_THREADS,
): AgentThreadRow[] {
  const active = rows.filter((row) => !isInactiveThread(row));
  const history = rows.filter(isInactiveThread);
  return [
    ...active.slice(0, MAX_VISIBLE_ACTIVE_THREADS),
    ...history.slice(0, Math.max(0, historyLimit)),
  ];
}

export function hiddenAgentThreadRowCount(
  rows: readonly AgentThreadRow[],
  visibleRows: readonly AgentThreadRow[],
): number {
  return Math.max(
    0,
    rows.filter(isInactiveThread).length -
      visibleRows.filter(isInactiveThread).length,
  );
}

export function groupAgentThreadRows(
  rows: readonly AgentThreadRow[],
): Array<[string, AgentThreadGroup]> {
  const result = new Map<string, AgentThreadGroup>();
  for (const row of rows) {
    const key = row.workspaceId ?? `other:${row.workspaceName}`;
    const group =
      result.get(key) ??
      ({
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        rows: [],
      } satisfies AgentThreadGroup);
    group.rows.push(row);
    result.set(key, group);
  }
  return [...result.entries()];
}

export function statusGlyph(status: AgentThreadRow['status']): string {
  if (status === 'working') return '●';
  if (status === 'compacting') return '◐';
  if (status === 'waiting') return '◆';
  if (status === 'failed') return '!';
  if (status === 'offline') return '○';
  if (status === 'dormant') return '◌';
  return '●';
}

export function statusLabel(row: AgentThreadRow): string {
  return row.statusLabel ?? row.status;
}

export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

export function workspaceNameForSession(
  snapshot: BrowserSnapshot,
  session: SessionIndexEntry,
  runtime?: RuntimeSnapshot,
): string {
  const workspace =
    snapshot.workspaces.find(
      (item: WorkspaceTarget) => item.id === session.workspaceId,
    ) ?? workspaceForPath(runtime?.cwd ?? session.cwd, snapshot.workspaces);
  return workspace?.name ?? 'Other workspace';
}
