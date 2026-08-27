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
  const managed = new Set(
    (snapshot.runs ?? []).flatMap((run) => {
      if (run.piSessionId) return [run.piSessionId];
      if (!run.runtimeId) return [];
      const runtime = snapshot.runtimes.find(
        (candidate) => candidate.runtimeId === run.runtimeId,
      );
      return runtime ? [runtime.session.id] : [];
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
export function durableThreadForSession(
  snapshot: Pick<BrowserSnapshot, 'runs'> &
    Partial<Pick<BrowserSnapshot, 'runtimes'>>,
  sessionId: string,
  threads: readonly Pick<
    Thread,
    'id' | 'archivedAt' | 'pinnedAt' | 'settledAt'
  >[],
  directLinks: readonly SessionThreadLink[] = [],
): DurableThreadMetadata | undefined {
  const runs = snapshot.runs ?? [];
  const runThreadIds = new Set(
    runs
      .filter((run) => run.piSessionId === sessionId)
      .map((run) => run.threadId),
  );
  const direct = directLinks.filter((link) => link.sessionId === sessionId);
  const directThreadIds = new Set(direct.map((link) => link.threadId));
  if (directThreadIds.size > 1) return undefined;
  const directLink = direct[0];
  if (directLink) {
    // Direct links are authoritative, but an old run projection that names a
    // different thread is a conflict, never a reason to guess.
    if ([...runThreadIds].some((threadId) => threadId !== directLink.threadId))
      return undefined;
    return {
      threadId: directLink.threadId,
      ...(directLink.archivedAt === undefined
        ? {}
        : { archivedAt: directLink.archivedAt }),
      ...(directLink.pinnedAt === undefined
        ? {}
        : { pinnedAt: directLink.pinnedAt }),
      ...(directLink.settledAt === undefined
        ? {}
        : { settledAt: directLink.settledAt }),
      hasActiveRun:
        directLink.activeRunId !== undefined ||
        runs.some(
          (run) =>
            run.threadId === directLink.threadId &&
            ACTIVE_RUN_STATUSES.includes(run.status),
        ) ||
        (snapshot.runtimes ?? []).some(
          (runtime) =>
            runtime.session.id === sessionId && runtime.online !== false,
        ),
    };
  }
  if (runThreadIds.size !== 1) return undefined;
  const threadId = [...runThreadIds][0];
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (!thread) return undefined;
  return {
    threadId,
    ...(thread.archivedAt === undefined
      ? {}
      : { archivedAt: thread.archivedAt }),
    ...(thread.pinnedAt === undefined ? {} : { pinnedAt: thread.pinnedAt }),
    ...(thread.settledAt === undefined ? {} : { settledAt: thread.settledAt }),
    hasActiveRun:
      runs.some(
        (run) =>
          run.threadId === threadId && ACTIVE_RUN_STATUSES.includes(run.status),
      ) ||
      (snapshot.runtimes ?? []).some(
        (runtime) =>
          runtime.session.id === sessionId && runtime.online !== false,
      ),
  };
}

function promotedDraftForSession(
  snapshot: Pick<BrowserSnapshot, 'runs'>,
  directLinks: readonly SessionThreadLink[],
  drafts: readonly DraftMetadata[],
  sessionId: string,
  runtimeId?: string,
): DraftMetadata | undefined {
  const threadIds = new Set(
    directLinks
      .filter((link) => link.sessionId === sessionId)
      .map((link) => link.threadId),
  );
  for (const run of snapshot.runs ?? []) {
    if (
      run.piSessionId === sessionId ||
      (runtimeId !== undefined && run.runtimeId === runtimeId)
    )
      threadIds.add(run.threadId);
  }
  if (threadIds.size !== 1) return undefined;
  const threadId = [...threadIds][0];
  return drafts.find((draft) => draft.promotedThreadId === threadId);
}

export function resolvedDraftPromotionIds(
  snapshot: Pick<BrowserSnapshot, 'runs' | 'runtimes' | 'sessions'>,
  directLinks: readonly SessionThreadLink[],
  drafts: readonly DraftMetadata[],
): string[] {
  return snapshot.sessions.flatMap((session) => {
    if (session.startedAt === undefined) return [];
    const draft = promotedDraftForSession(
      snapshot,
      directLinks,
      drafts,
      session.id,
      snapshot.runtimes.find((runtime) => runtime.session.id === session.id)
        ?.runtimeId,
    );
    return draft ? [draft.id] : [];
  });
}

export function agentThreadRows(
  snapshot: BrowserSnapshot,
  durableThreads?: readonly Pick<
    Thread,
    'id' | 'archivedAt' | 'pinnedAt' | 'settledAt'
  >[],
  directLinks: readonly SessionThreadLink[] = [],
  drafts: readonly DraftMetadata[] = [],
): AgentThreadRow[] {
  const authoritativeThreads = snapshot.threads ?? durableThreads;
  const durableForSession =
    authoritativeThreads !== undefined || directLinks.length > 0
      ? new Map(
          [
            ...snapshot.runtimes.map((runtime) => runtime.session.id),
            ...snapshot.sessions.map((session) => session.id),
          ].map((sessionId) => [
            sessionId,
            durableThreadForSession(
              snapshot,
              sessionId,
              authoritativeThreads ?? [],
              directLinks,
            ),
          ]),
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
      snapshot,
      directLinks,
      drafts,
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
      snapshot,
      directLinks,
      drafts,
      session.id,
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
        (snapshot.runs ?? []).some(
          (run) =>
            run.threadId === draft.promotedThreadId &&
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
  return row.statusLabel ?? row.status;
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
