import { ACTIVE_RUN_STATUSES } from '@pi-dashboard/domain';
import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  SessionIndexEntry,
  Thread,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { workspaceForPath } from '@pi-dashboard/protocol';
import { sessionDisplayTitle } from '../../app-helpers';
import { dashboardStatus } from '../presentation-status';

export type DurableThreadMetadata = {
  threadId: string;
  archivedAt?: number;
  pinnedAt?: number;
  hasActiveRun: boolean;
};

export type AgentThreadRow = {
  id: string;
  title: string;
  workspaceId?: string;
  workspaceName: string;
  cwd: string;
  durableThread?: DurableThreadMetadata;
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
export function isArchivedThread(row: AgentThreadRow): boolean {
  return row.durableThread?.archivedAt !== undefined;
}

export function isHistoryThread(row: AgentThreadRow): boolean {
  return (
    !isArchivedThread(row) &&
    (row.status === 'offline' || row.status === 'dormant')
  );
}

/**
 * Join a Pi session to a durable thread only through the persisted run
 * identity. A session with conflicting durable thread identities is
 * deliberately left unmapped rather than guessed.
 */
export function durableThreadForSession(
  snapshot: Pick<BrowserSnapshot, 'runs'>,
  sessionId: string,
  threads: readonly Pick<Thread, 'id' | 'archivedAt' | 'pinnedAt'>[],
): DurableThreadMetadata | undefined {
  const runs = snapshot.runs ?? [];
  const threadIds = new Set(
    runs
      .filter((run) => run.piSessionId === sessionId)
      .map((run) => run.threadId),
  );
  if (threadIds.size !== 1) return undefined;
  const threadId = [...threadIds][0];
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (!thread) return undefined;
  return {
    threadId,
    ...(thread.archivedAt === undefined
      ? {}
      : { archivedAt: thread.archivedAt }),
    ...(thread.pinnedAt === undefined ? {} : { pinnedAt: thread.pinnedAt }),
    hasActiveRun: runs.some(
      (run) =>
        run.threadId === threadId && ACTIVE_RUN_STATUSES.includes(run.status),
    ),
  };
}

export function agentThreadRows(
  snapshot: BrowserSnapshot,
  durableThreads?: readonly Pick<Thread, 'id' | 'archivedAt' | 'pinnedAt'>[],
): AgentThreadRow[] {
  const durableForSession = durableThreads
    ? new Map(
        [
          ...snapshot.runtimes.map((runtime) => runtime.session.id),
          ...snapshot.sessions.map((session) => session.id),
        ].map((sessionId) => [
          sessionId,
          durableThreadForSession(snapshot, sessionId, durableThreads),
        ]),
      )
    : undefined;
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
      durableThread: durableForSession?.get(runtime.session.id),
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
      durableThread: durableForSession?.get(session.id),
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
  return !isHistoryThread(row) && row.session?.startedAt === undefined ? -1 : 0;
}

export function filterAgentThreadRows(
  rows: readonly AgentThreadRow[],
  query: string,
): AgentThreadRow[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? rows.filter((row) =>
        `${row.title} ${row.workspaceName} ${row.cwd} ${row.status} ${
          isArchivedThread(row) ? 'archived' : ''
        }`
          .toLowerCase()
          .includes(needle),
      )
    : [...rows];
}

function pinnedFirst(rows: readonly AgentThreadRow[]): AgentThreadRow[] {
  return [...rows].sort(
    (left, right) =>
      Number(left.durableThread?.pinnedAt === undefined) -
        Number(right.durableThread?.pinnedAt === undefined) ||
      (right.durableThread?.pinnedAt ?? 0) -
        (left.durableThread?.pinnedAt ?? 0),
  );
}

export function searchAgentThreadRows(
  rows: readonly AgentThreadRow[],
): AgentThreadRow[] {
  const active = pinnedFirst(
    rows.filter((row) => !isHistoryThread(row) && !isArchivedThread(row)),
  );
  const history = pinnedFirst(rows.filter(isHistoryThread));
  const archived = pinnedFirst(rows.filter(isArchivedThread));
  return [
    ...active.slice(0, MAX_VISIBLE_ACTIVE_THREADS),
    ...history,
    ...archived,
  ];
}

export function historyRowsForShelf(
  rows: readonly AgentThreadRow[],
  expanded: boolean,
  selectedSessionId?: string,
): AgentThreadRow[] {
  return expanded
    ? pinnedFirst(rows)
    : rows.filter((row) => row.id === selectedSessionId);
}

export function archivedRowsForShelf(
  rows: readonly AgentThreadRow[],
  expanded: boolean,
  selectedSessionId?: string,
): AgentThreadRow[] {
  return expanded
    ? pinnedFirst(rows)
    : rows.filter((row) => row.id === selectedSessionId);
}

export function boundedAgentThreadRows(
  rows: readonly AgentThreadRow[],
  historyLimit = MAX_VISIBLE_HISTORY_THREADS,
  selectedSessionId?: string,
): AgentThreadRow[] {
  const active = pinnedFirst(
    rows.filter((row) => !isHistoryThread(row) && !isArchivedThread(row)),
  );
  const history = pinnedFirst(rows.filter(isHistoryThread));
  const archived = pinnedFirst(rows.filter(isArchivedThread));
  const visibleHistory = history.slice(0, Math.max(0, historyLimit));
  const selected = selectedSessionId
    ? history.find((row) => row.id === selectedSessionId)
    : undefined;
  if (selected && !visibleHistory.some((row) => row.id === selected.id)) {
    visibleHistory.push(selected);
  }
  return [
    ...active.slice(0, MAX_VISIBLE_ACTIVE_THREADS),
    ...visibleHistory,
    ...archived,
  ];
}

export function hiddenAgentThreadRowCount(
  rows: readonly AgentThreadRow[],
  visibleRows: readonly AgentThreadRow[],
): number {
  return Math.max(
    0,
    rows.filter(isHistoryThread).length -
      visibleRows.filter(isHistoryThread).length,
  );
}

export function workspaceGroupIsExpanded(
  collapsed: boolean,
  searching: boolean,
): boolean {
  return !collapsed || searching;
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
  if (status === 'compacting' || status === 'waiting') return '◐';
  if (status === 'input') return '◆';
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
