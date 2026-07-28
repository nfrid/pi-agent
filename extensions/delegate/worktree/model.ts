/**
 * Worktrees exist so several agents (and you) can work in parallel on one
 * repository without colliding. They are not a security boundary — the child
 * agent is trusted — so there is no sandbox, no writable-path allowlist, and no
 * patch broker. The blast radius is the worktree, and the result is an ordinary
 * git branch.
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
  sessionToken?: string;
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
  /** Whether the parent's uncommitted work was carried in. */
  carriedWip: boolean;
  /** Paths symlinked from the parent, relative to the worktree root. */
  dependencyLinks: string[];
  /** Gitignored files copied in from the parent, relative to the worktree root. */
  carriedFiles: string[];
  status: WorktreeStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * Commit holding the parent's carried uncommitted work, when there was any.
   * The agent's own work starts here rather than at baseHead, which is what
   * makes the two separable on review.
   */
  carryCommit?: string;
  /** Commit holding the agent's work, once finished. */
  headCommit?: string;
  /** Files the agent changed relative to workBase. */
  changedPaths?: string[];
  error?: string;
  /** The retained terminal outcome that caused this branch to be kept. */
  runOutcome?: WorktreeRunOutcome;
}

/** The commit the agent's own work starts from. */
export function workBase(record: WorktreeRecord): string {
  return record.carryCommit ?? record.baseHead;
}

export interface PreparedWorktree {
  record: WorktreeRecord;
  /** Environment additions for the child process. */
  env: NodeJS.ProcessEnv;
}

export interface WorktreePreparation {
  worktree?: PreparedWorktree;
  /** Why a requested worktree could not be prepared. Callers fail closed. */
  fallbackReason?: string;
}

/** What the parent needs in order to integrate the work itself. */
export interface WorktreeSummary {
  id: string;
  branch: string;
  worktreePath: string;
  repositoryRoot: string;
  baseHead: string;
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
}

export function worktreeSummary(record: WorktreeRecord): WorktreeSummary {
  const base = workBase(record);
  return {
    id: record.id,
    branch: record.branch,
    worktreePath: record.worktreePath,
    repositoryRoot: record.repositoryRoot,
    baseHead: record.baseHead,
    workBase: base,
    status: record.status,
    headCommit: record.headCommit,
    changedPaths: record.changedPaths,
    hasWork: Boolean(record.headCommit && record.headCommit !== base),
    error: record.error,
    runOutcome: record.runOutcome,
  };
}
