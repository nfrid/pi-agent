/**
 * Shared state and projections for a Git-backed isolated checkout.
 *
 * Persistence is deliberately owned by the caller. The manager only needs
 * these lifecycle fields and never assumes where records are stored.
 */

/** Where a fresh worktree starts from. */
export type WorktreeBase =
  /** The parent's current working state, uncommitted work included. */
  | 'wip'
  /** The parent's last commit, ignoring uncommitted work. */
  | 'head';

export type WorktreeStatus = 'active' | 'finished' | 'removed';
export type WorktreeRunOutcome = 'timed-out' | 'aborted' | 'error';

export interface WorktreeRecord {
  version: 1;
  id: string;
  repositoryRoot: string;
  /** Absolute path to the checkout. */
  worktreePath: string;
  /** Working directory the agent starts in, relative to the worktree root. */
  workingDirectory: string;
  /** The branch the worktree is checked out on; this is what carries the work. */
  branch: string;
  /** Commit the branch was created from. */
  baseHead: string;
  base: WorktreeBase;
  /** Explicit branch/ref selected as the base, when configured by the caller. */
  baseRef?: string;
  /** Whether the parent's uncommitted work was carried in. */
  carriedWip: boolean;
  status: WorktreeStatus;
  createdAt: string;
  updatedAt: string;
  /** Commit holding the parent's carried uncommitted work, when there was any. */
  carryCommit?: string;
  /**
   * Latest branch tip recorded by lifecycle finalization. Integration checks
   * that this persisted provenance remains an ancestor before reviewing or
   * merging, while continuations may append commits after it.
   */
  headCommit?: string;
  /** Files the agent changed relative to workBase. */
  changedPaths?: string[];
  error?: string;
  /** The retained terminal outcome that caused this branch to be kept. */
  runOutcome?: WorktreeRunOutcome;
  /** A clean read-only snapshot whose checkout was retired but whose ref remains resumable. */
  snapshot?: boolean;
}

/** The commit the agent's own work starts from. */
export function workBase(record: WorktreeRecord): string {
  return record.carryCommit ?? record.baseHead;
}

export interface PreparedWorktree<
  Record extends WorktreeRecord = WorktreeRecord,
> {
  record: Record;
  /** Environment additions for the child process. */
  env: NodeJS.ProcessEnv;
}

export interface WorktreePreparation<
  Record extends WorktreeRecord = WorktreeRecord,
> {
  worktree?: PreparedWorktree<Record>;
  /** Why a requested worktree could not be prepared. Callers fail closed. */
  fallbackReason?: string;
}

/** What the caller needs in order to integrate the work itself. */
export interface WorktreeSummary {
  id: string;
  branch: string;
  worktreePath: string;
  repositoryRoot: string;
  baseHead: string;
  /** Explicit branch/ref selected as the base, when configured by the caller. */
  baseRef?: string;
  /** Where the agent's own work starts: the carry commit, or baseHead. */
  workBase: string;
  status: WorktreeStatus;
  headCommit?: string;
  changedPaths?: string[];
  /** True when the agent committed something of its own beyond workBase. */
  hasWork: boolean;
  error?: string;
  /** The retained terminal outcome that caused this branch to be kept. */
  runOutcome?: WorktreeRunOutcome;
  /** True when this is a retired, resumable read-only snapshot rather than integration work. */
  snapshot?: boolean;
  /** Bounded source selector, safe to include in aggregate lifecycle metrics. */
  snapshotBase?: WorktreeBase;
}

export function worktreeSummary(record: WorktreeRecord): WorktreeSummary {
  const base = workBase(record);
  return {
    id: record.id,
    branch: record.branch,
    worktreePath: record.worktreePath,
    repositoryRoot: record.repositoryRoot,
    baseHead: record.baseHead,
    baseRef: record.baseRef,
    workBase: base,
    status: record.status,
    headCommit: record.headCommit,
    changedPaths: record.changedPaths,
    hasWork: Boolean(record.headCommit && record.headCommit !== base),
    error: record.error,
    runOutcome: record.runOutcome,
    snapshot: record.snapshot,
    snapshotBase: record.base,
  };
}
