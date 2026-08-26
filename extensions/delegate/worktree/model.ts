import {
  type PreparedWorktree as GenericPreparedWorktree,
  type WorktreeBase as GenericWorktreeBase,
  type WorktreeOwnership as GenericWorktreeOwnership,
  type WorktreePreparation as GenericWorktreePreparation,
  type WorktreeRecord as GenericWorktreeRecord,
  type WorktreeRunOutcome as GenericWorktreeRunOutcome,
  type WorktreeStatus as GenericWorktreeStatus,
  type WorktreeSummary as GenericWorktreeSummary,
  workBase as genericWorkBase,
  worktreeSummary as genericWorktreeSummary,
} from '@pi-dashboard/worktree-manager';

/**
 * Delegate-specific durable metadata remains file-record state. Git lifecycle
 * fields and projections come from the reusable worktree manager package.
 */
export type WorktreeBase = GenericWorktreeBase;
export type WorktreeStatus = GenericWorktreeStatus;
export type WorktreeRunOutcome = GenericWorktreeRunOutcome;
export type WorktreeOwnership = GenericWorktreeOwnership;

export interface WorktreeRecord extends GenericWorktreeRecord {
  sessionToken?: string;
  /** Earliest integration base inherited through a delegate `base` chain. */
  integrationBase?: string;
  /** Parent Pi session that first created this retained record. */
  creatorSessionId?: string;
  /** Bounded recent parent-session touches; creatorSessionId is never evicted. */
  recentParentSessionIds?: string[];
  /** Legacy touch projection retained for backwards-compatible reads. */
  parentSessionIds?: string[];
}

export type PreparedWorktree = GenericPreparedWorktree<WorktreeRecord>;
export type WorktreePreparation = GenericWorktreePreparation<WorktreeRecord>;
export type WorktreeSummary = GenericWorktreeSummary;

export const workBase = genericWorkBase;
export const worktreeSummary = genericWorktreeSummary;
