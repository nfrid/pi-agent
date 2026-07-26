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
  /** Commit holding the agent's work, once finished. */
  headCommit?: string;
  /** Files the agent changed relative to baseHead. */
  changedPaths?: string[];
  error?: string;
}

export interface PreparedWorktree {
  record: WorktreeRecord;
  /** Environment additions for the child process. */
  env: NodeJS.ProcessEnv;
}

export interface WorktreePreparation {
  worktree?: PreparedWorktree;
  /** Why a worktree could not be prepared. The run continues without one. */
  fallbackReason?: string;
}

/** What the parent needs in order to integrate the work itself. */
export interface WorktreeSummary {
  id: string;
  branch: string;
  worktreePath: string;
  repositoryRoot: string;
  baseHead: string;
  status: WorktreeStatus;
  headCommit?: string;
  changedPaths?: string[];
  /** True when the branch has commits beyond baseHead. */
  hasWork: boolean;
  error?: string;
}

export function worktreeSummary(record: WorktreeRecord): WorktreeSummary {
  return {
    id: record.id,
    branch: record.branch,
    worktreePath: record.worktreePath,
    repositoryRoot: record.repositoryRoot,
    baseHead: record.baseHead,
    status: record.status,
    headCommit: record.headCommit,
    changedPaths: record.changedPaths,
    hasWork: Boolean(
      record.headCommit && record.headCommit !== record.baseHead,
    ),
    error: record.error,
  };
}
