import { ACTIVE_RUN_STATUSES } from '@pi-dashboard/domain';
import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  SessionIndexEntry,
  SessionThreadLink,
  Thread,
} from '@pi-dashboard/protocol';
import { sessionDisplayTitle } from '../../app-helpers';
import { readComposerDraft } from '../composer/draft';
import type { DraftMetadata } from '../drafts';
import { dashboardStatus } from '../presentation-status';

export type DurableThreadMetadata = {
  threadId: string;
  checkoutId?: string;
  archivedAt?: number;
  settledAt?: number;
  pinnedAt?: number;
  hasActiveRun: boolean;
};

export type AgentThreadRow = {
  id: string;
  title: string;
  projectId?: string;
  projectName: string;
  cwd: string;
  durableThread?: DurableThreadMetadata;
  status:
    | RuntimeSnapshot['liveState']
    | 'draft'
    | 'paused'
    | 'offline'
    | 'dormant'
    | 'input';
  statusLabel?: string;
  runtime?: RuntimeSnapshot;
  session?: SessionIndexEntry;
  draft?: DraftMetadata;
  startedAt?: number;
  updatedAt?: number;
};

export type AgentThreadSections = {
  pinned: AgentThreadRow[];
  active: AgentThreadRow[];
  archived: AgentThreadRow[];
  settled: AgentThreadRow[];
};

export const MAX_VISIBLE_ACTIVE_THREADS = 40;

type SnapshotRun = NonNullable<BrowserSnapshot['runs']>[number];
type DurableThread = Pick<
  Thread,
  'id' | 'checkoutId' | 'archivedAt' | 'pinnedAt' | 'settledAt'
>;

type ThreadNavIndexes = {
  runsBySessionId: Map<string, SnapshotRun[]>;
  runsByRuntimeId: Map<string, SnapshotRun[]>;
  runsByThreadId: Map<string, SnapshotRun[]>;
  linksBySessionId: Map<string, SessionThreadLink[]>;
  threadsById: Map<string, DurableThread>;
  runtimesBySessionId: Map<string, RuntimeSnapshot[]>;
  draftsByThreadId: Map<string, DraftMetadata>;
};

/**
 * Navigation is a read-only join over independent live/indexed projections.
 * Build its indexes once per derivation so each row does not repeat the same
 * session, run, link, and thread scans.
 */
function buildThreadNavIndexes(
  snapshot: Pick<BrowserSnapshot, 'runs'> &
    Partial<Pick<BrowserSnapshot, 'runtimes'>>,
  threads: readonly DurableThread[],
  directLinks: readonly SessionThreadLink[],
  drafts: readonly DraftMetadata[],
): ThreadNavIndexes {
  const runsBySessionId = new Map<string, SnapshotRun[]>();
  const runsByRuntimeId = new Map<string, SnapshotRun[]>();
  const runsByThreadId = new Map<string, SnapshotRun[]>();
  for (const run of snapshot.runs ?? []) {
    if (run.piSessionId) {
      const sessionRuns = runsBySessionId.get(run.piSessionId) ?? [];
      sessionRuns.push(run);
      runsBySessionId.set(run.piSessionId, sessionRuns);
    }
    if (run.runtimeId) {
      const runtimeRuns = runsByRuntimeId.get(run.runtimeId) ?? [];
      runtimeRuns.push(run);
      runsByRuntimeId.set(run.runtimeId, runtimeRuns);
    }
    const threadRuns = runsByThreadId.get(run.threadId) ?? [];
    threadRuns.push(run);
    runsByThreadId.set(run.threadId, threadRuns);
  }
  const linksBySessionId = new Map<string, SessionThreadLink[]>();
  for (const link of directLinks) {
    const sessionLinks = linksBySessionId.get(link.sessionId) ?? [];
    sessionLinks.push(link);
    linksBySessionId.set(link.sessionId, sessionLinks);
  }
  const runtimesBySessionId = new Map<string, RuntimeSnapshot[]>();
  for (const runtime of snapshot.runtimes ?? []) {
    const sessionRuntimes = runtimesBySessionId.get(runtime.session.id) ?? [];
    sessionRuntimes.push(runtime);
    runtimesBySessionId.set(runtime.session.id, sessionRuntimes);
  }
  const draftsByThreadId = new Map<string, DraftMetadata>();
  for (const draft of drafts) {
    if (draft.promotedThreadId && !draftsByThreadId.has(draft.promotedThreadId))
      draftsByThreadId.set(draft.promotedThreadId, draft);
  }
  return {
    runsBySessionId,
    runsByRuntimeId,
    runsByThreadId,
    linksBySessionId,
    threadsById: new Map(threads.map((thread) => [thread.id, thread])),
    runtimesBySessionId,
    draftsByThreadId,
  };
}

/** Stable unmatched identity set used to refresh persisted session links. */
export function sessionThreadIdentityKey(
  snapshot: Pick<BrowserSnapshot, 'sessions' | 'runtimes' | 'runs'>,
): string {
  const delegateSessions = new Set(
    snapshot.sessions
      .filter((session) => session.sessionKind === 'delegate')
      .map((session) => session.id),
  );
  const indexed = new Set(
    snapshot.sessions
      .filter((session) => session.sessionKind !== 'delegate')
      .map((session) => session.id),
  );
  const sessionByRuntimeId = new Map(
    snapshot.sessions.flatMap((session) =>
      session.activeRuntimeId
        ? [[session.activeRuntimeId, session.id] as const]
        : [],
    ),
  );
  for (const runtime of snapshot.runtimes)
    sessionByRuntimeId.set(runtime.runtimeId, runtime.session.id);
  const managed = new Set(
    (snapshot.runs ?? []).flatMap((run) => {
      if (run.piSessionId) return [run.piSessionId];
      if (!run.runtimeId) return [];
      const sessionId = sessionByRuntimeId.get(run.runtimeId);
      return sessionId ? [sessionId] : [];
    }),
  );
  return [
    ...new Set([
      ...snapshot.sessions.map((session) => session.id),
      ...snapshot.runtimes.map((runtime) => runtime.session.id),
    ]),
  ]
    .filter(
      (sessionId) =>
        !managed.has(sessionId) && !delegateSessions.has(sessionId),
    )
    .sort()
    .map(
      (sessionId) =>
        `${indexed.has(sessionId) ? 'indexed' : 'runtime'}:${sessionId}`,
    )
    .join('\n');
}

// Runtime snapshots are live overlays, not session-index metadata. Keep their
// chronology neutral until the authoritative index publishes a real timestamp.
export function isArchivedThread(row: AgentThreadRow): boolean {
  return row.durableThread?.archivedAt !== undefined;
}

export function isUnavailableThread(row: AgentThreadRow): boolean {
  return (
    !isArchivedThread(row) &&
    (row.status === 'offline' || row.status === 'dormant')
  );
}

/**
 * Join a Pi session through the exact link projection, with the persisted run
 * identity retained as a rollout fallback. Conflicting identities are left
 * unmapped rather than guessed.
 */
function durableThreadForSessionFromIndexes(
  indexes: ThreadNavIndexes,
  sessionId: string,
): DurableThreadMetadata | undefined {
  const runThreadIds = new Set(
    (indexes.runsBySessionId.get(sessionId) ?? []).map((run) => run.threadId),
  );
  const direct = indexes.linksBySessionId.get(sessionId) ?? [];
  const directThreadIds = new Set(direct.map((link) => link.threadId));
  if (directThreadIds.size > 1) return undefined;
  const directLink = direct[0];
  const threadId =
    directLink?.threadId ??
    (runThreadIds.size === 1 ? [...runThreadIds][0] : undefined);
  if (threadId === undefined) return undefined;
  if (
    directLink &&
    [...runThreadIds].some((candidate) => candidate !== directLink.threadId)
  )
    return undefined;
  const thread = indexes.threadsById.get(threadId);
  if (!directLink && !thread) return undefined;
  const runs = indexes.runsByThreadId.get(threadId) ?? [];
  const hasLiveRuntime = (
    indexes.runtimesBySessionId.get(sessionId) ?? []
  ).some((runtime) => runtime.online !== false);
  return {
    threadId,
    ...(thread?.checkoutId ? { checkoutId: thread.checkoutId } : {}),
    ...(directLink
      ? directLink.archivedAt === undefined
        ? {}
        : { archivedAt: directLink.archivedAt }
      : thread?.archivedAt === undefined
        ? {}
        : { archivedAt: thread.archivedAt }),
    ...(directLink
      ? directLink.pinnedAt === undefined
        ? {}
        : { pinnedAt: directLink.pinnedAt }
      : thread?.pinnedAt === undefined
        ? {}
        : { pinnedAt: thread.pinnedAt }),
    ...(directLink
      ? directLink.settledAt === undefined
        ? {}
        : { settledAt: directLink.settledAt }
      : thread?.settledAt === undefined
        ? {}
        : { settledAt: thread.settledAt }),
    hasActiveRun:
      directLink?.activeRunId !== undefined ||
      runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status)) ||
      hasLiveRuntime,
  };
}

/** Public single-join API; row derivations use the shared pre-indexed path. */
export function durableThreadForSession(
  snapshot: Pick<BrowserSnapshot, 'runs'> &
    Partial<Pick<BrowserSnapshot, 'runtimes'>>,
  sessionId: string,
  threads: readonly DurableThread[],
  directLinks: readonly SessionThreadLink[] = [],
): DurableThreadMetadata | undefined {
  return durableThreadForSessionFromIndexes(
    buildThreadNavIndexes(snapshot, threads, directLinks, []),
    sessionId,
  );
}

function promotedDraftForSession(
  indexes: ThreadNavIndexes,
  sessionId: string,
  runtimeId?: string,
): DraftMetadata | undefined {
  const threadIds = new Set(
    (indexes.linksBySessionId.get(sessionId) ?? []).map(
      (link) => link.threadId,
    ),
  );
  for (const run of indexes.runsBySessionId.get(sessionId) ?? [])
    threadIds.add(run.threadId);
  if (runtimeId !== undefined)
    for (const run of indexes.runsByRuntimeId.get(runtimeId) ?? [])
      threadIds.add(run.threadId);
  if (threadIds.size !== 1) return undefined;
  return indexes.draftsByThreadId.get([...threadIds][0]);
}

export function resolvedDraftPromotionIds(
  snapshot: Pick<BrowserSnapshot, 'runs' | 'runtimes' | 'sessions'>,
  directLinks: readonly SessionThreadLink[],
  drafts: readonly DraftMetadata[],
): string[] {
  const indexes = buildThreadNavIndexes(snapshot, [], directLinks, drafts);
  return snapshot.sessions.flatMap((session) => {
    if (session.startedAt === undefined) return [];
    const runtimeId =
      indexes.runtimesBySessionId.get(session.id)?.[0]?.runtimeId ??
      session.activeRuntimeId;
    const draft = promotedDraftForSession(indexes, session.id, runtimeId);
    return draft ? [draft.id] : [];
  });
}

export type AgentThreadSnapshot = Pick<
  BrowserSnapshot,
  'projects' | 'runs' | 'runtimes' | 'sessions' | 'threads'
>;

export function agentThreadRows(
  snapshot: AgentThreadSnapshot,
  durableThreads?: readonly Pick<
    Thread,
    'id' | 'archivedAt' | 'pinnedAt' | 'settledAt'
  >[],
  directLinks: readonly SessionThreadLink[] = [],
  drafts: readonly DraftMetadata[] = [],
): AgentThreadRow[] {
  const authoritativeThreads = snapshot.threads ?? durableThreads;
  const indexes = buildThreadNavIndexes(
    snapshot,
    authoritativeThreads ?? [],
    directLinks,
    drafts,
  );
  const sessionIds = new Set([
    ...snapshot.runtimes.map((runtime) => runtime.session.id),
    ...snapshot.sessions.map((session) => session.id),
  ]);
  const durableForSession =
    authoritativeThreads !== undefined || directLinks.length > 0
      ? new Map(
          [...sessionIds].map(
            (sessionId) =>
              [
                sessionId,
                durableThreadForSessionFromIndexes(indexes, sessionId),
              ] as const,
          ),
        )
      : undefined;
  const projectsById = new Map(
    (snapshot.projects ?? []).map((project) => [project.id, project]),
  );
  const sessionsById = new Map(
    snapshot.sessions.map((session) => [session.id, session]),
  );
  const rows = new Map<string, AgentThreadRow>();
  const representedPromotedDraftIds = new Set<string>();
  for (const runtime of snapshot.runtimes) {
    const session = sessionsById.get(runtime.session.id);
    if (session?.sessionKind === 'delegate') continue;
    const projectId = runtime.projectId ?? session?.projectId;
    const presentation = dashboardStatus(runtime);
    const promotedDraft = promotedDraftForSession(
      indexes,
      runtime.session.id,
      runtime.runtimeId,
    );
    if (promotedDraft) representedPromotedDraftIds.add(promotedDraft.id);
    rows.set(runtime.session.id, {
      id: runtime.session.id,
      title: sessionDisplayTitle(runtime.session, runtime.session.entries),
      ...(projectId ? { projectId } : {}),
      projectName: projectId
        ? (projectsById.get(projectId)?.title ?? 'Unknown project')
        : 'Unassigned',
      cwd: runtime.cwd,
      durableThread: durableForSession?.get(runtime.session.id),
      status: presentation.status,
      statusLabel: presentation.label,
      runtime,
      session,
      startedAt: session?.startedAt ?? promotedDraft?.updatedAt,
      updatedAt: session?.updatedAt ?? promotedDraft?.updatedAt,
    });
  }
  for (const session of snapshot.sessions) {
    if (session.sessionKind === 'delegate' || rows.has(session.id)) continue;
    const projectId = session.projectId;
    const promotedDraft = promotedDraftForSession(
      indexes,
      session.id,
      session.activeRuntimeId,
    );
    if (promotedDraft) representedPromotedDraftIds.add(promotedDraft.id);
    rows.set(session.id, {
      id: session.id,
      title: sessionDisplayTitle(session),
      ...(projectId ? { projectId } : {}),
      projectName: projectId
        ? (projectsById.get(projectId)?.title ?? 'Unknown project')
        : 'Unassigned',
      cwd: session.cwd,
      durableThread: durableForSession?.get(session.id),
      status: 'dormant',
      session,
      startedAt: session.startedAt ?? promotedDraft?.updatedAt ?? 0,
      updatedAt: session.updatedAt ?? promotedDraft?.updatedAt,
    });
  }
  for (const draft of drafts) {
    if (representedPromotedDraftIds.has(draft.id)) continue;
    const project = projectsById.get(draft.projectId);
    const prompt = readComposerDraft(draft.id).replace(/\s+/gu, ' ').trim();
    const starting = Boolean(
      draft.promotedThreadId &&
        (indexes.runsByThreadId.get(draft.promotedThreadId) ?? []).some((run) =>
          ACTIVE_RUN_STATUSES.includes(run.status),
        ),
    );
    rows.set(draft.id, {
      id: draft.id,
      title:
        draft.title ||
        (prompt ? [...prompt].slice(0, 96).join('') : 'New draft'),
      projectId: draft.projectId,
      projectName: project?.title ?? 'Unknown project',
      cwd: project?.rootPath ?? '',
      status: starting ? 'waiting' : 'draft',
      statusLabel: starting ? 'starting' : 'draft',
      draft,
      startedAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    });
  }
  return [...rows.values()].sort(
    (left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0),
  );
}

export function canSettleThread(row: AgentThreadRow): boolean {
  return Boolean(
    row.durableThread &&
      row.durableThread.archivedAt === undefined &&
      row.durableThread.settledAt === undefined &&
      ['idle', 'failed', 'offline', 'dormant'].includes(row.status),
  );
}

export type BulkThreadAction =
  | 'archive'
  | 'restore'
  | 'pin'
  | 'unpin'
  | 'settle'
  | 'unsettle';

/** Lifecycle actions whose preconditions hold for every selected thread. */
export function bulkThreadActions(
  rows: readonly AgentThreadRow[],
): BulkThreadAction[] {
  if (!rows.length || rows.some((row) => !row.durableThread)) return [];
  const actions: BulkThreadAction[] = [];
  const threads = rows.flatMap((row) =>
    row.durableThread ? [row.durableThread] : [],
  );
  if (threads.every((thread) => thread.pinnedAt === undefined))
    actions.push('pin');
  else if (threads.every((thread) => thread.pinnedAt !== undefined))
    actions.push('unpin');
  if (rows.every(canSettleThread)) actions.push('settle');
  else if (
    threads.every(
      (thread) =>
        thread.archivedAt === undefined && thread.settledAt !== undefined,
    )
  )
    actions.push('unsettle');
  if (
    threads.every(
      (thread) =>
        thread.archivedAt === undefined && thread.hasActiveRun === false,
    )
  )
    actions.push('archive');
  else if (threads.every((thread) => thread.archivedAt !== undefined))
    actions.push('restore');
  return actions;
}

export function filterAgentThreadRows(
  rows: readonly AgentThreadRow[],
  query: string,
): AgentThreadRow[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? rows.filter((row) =>
        `${row.title} ${row.projectName} ${row.cwd} ${row.status} ${
          isArchivedThread(row) ? 'archived' : ''
        } ${row.durableThread?.settledAt !== undefined ? 'settled' : ''}`
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

function isPinnedThread(row: AgentThreadRow): boolean {
  return row.durableThread?.pinnedAt !== undefined;
}

/** Partition the sidebar into the T3-style hierarchy without duplicating rows. */
export function sectionAgentThreadRows(
  rows: readonly AgentThreadRow[],
  activeLimit = MAX_VISIBLE_ACTIVE_THREADS,
  selectedSessionId?: string,
): AgentThreadSections {
  const pinned = pinnedFirst(
    rows.filter((row) => isPinnedThread(row) && !isArchivedThread(row)),
  );
  // Runtime absence is availability, not a lifecycle shelf. Dormant and
  // offline sessions therefore remain in Active until explicitly archived.
  const allSettled = pinnedFirst(
    rows.filter(
      (row) =>
        !isPinnedThread(row) &&
        !isArchivedThread(row) &&
        row.durableThread?.settledAt !== undefined,
    ),
  );
  const allActive = pinnedFirst(
    rows.filter(
      (row) =>
        !isPinnedThread(row) &&
        !isArchivedThread(row) &&
        row.durableThread?.settledAt === undefined,
    ),
  );
  const active = allActive.slice(
    0,
    Number.isFinite(activeLimit) ? Math.max(0, activeLimit) : undefined,
  );
  const selected = selectedSessionId
    ? allActive.find((row) => row.id === selectedSessionId)
    : undefined;
  if (selected && !active.some((row) => row.id === selected.id))
    active.push(selected);
  return {
    pinned,
    active,
    archived: pinnedFirst(rows.filter(isArchivedThread)),
    settled: allSettled,
  };
}

export function displayedAgentThreadRows(
  sections: AgentThreadSections,
  displayedSettled: readonly AgentThreadRow[] = sections.settled,
  displayedArchived: readonly AgentThreadRow[] = sections.archived,
): AgentThreadRow[] {
  return [
    ...sections.pinned,
    ...sections.active,
    ...displayedSettled,
    ...displayedArchived,
  ];
}

export function agentThreadShortcutTargetIds(
  rows: readonly AgentThreadRow[],
): string[] {
  return rows.slice(0, 9).map((row) => row.id);
}

export function hiddenAgentThreadRowCount(
  rows: readonly AgentThreadRow[],
  visibleRows: readonly AgentThreadRow[],
): number {
  return Math.max(
    0,
    rows.filter(
      (row) =>
        !isPinnedThread(row) &&
        !isArchivedThread(row) &&
        row.durableThread?.settledAt === undefined,
    ).length -
      visibleRows.filter(
        (row) =>
          !isPinnedThread(row) &&
          !isArchivedThread(row) &&
          row.durableThread?.settledAt === undefined,
      ).length,
  );
}

export function statusGlyph(status: AgentThreadRow['status']): string {
  if (status === 'working') return '●';
  if (status === 'compacting' || status === 'waiting') return '◐';
  if (status === 'input') return '◆';
  if (status === 'failed') return '!';
  if (status === 'offline') return '○';
  if (status === 'dormant') return '◌';
  if (status === 'draft') return '✎';
  return '●';
}

export function statusLabel(row: AgentThreadRow): string {
  if (row.statusLabel) return row.statusLabel;
  if (row.status === 'dormant' || row.status === 'idle') return 'ready';
  return row.status;
}

export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

export function projectNameForSession(
  snapshot: BrowserSnapshot,
  session: SessionIndexEntry,
  runtime?: RuntimeSnapshot,
): string {
  const projectId = runtime?.projectId ?? session.projectId;
  if (!projectId) return 'Unassigned';
  return (
    (snapshot.projects ?? []).find((project) => project.id === projectId)
      ?.title ?? 'Unknown project'
  );
}
