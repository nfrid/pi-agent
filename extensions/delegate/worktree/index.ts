/**
 * Seamless git worktrees for parallel delegated work.
 *
 * A writable delegate gets its own checkout on a real named branch. Git's native
 * checkout/setup hooks prepare each child when configured, and the parent's
 * uncommitted work is carried in by default. When the run ends the branch holds
 * the work, and the orchestrator integrates it with ordinary git rather than a
 * bespoke patch protocol.
 */

export type { CapturedWipSource } from '@pi-dashboard/worktree-manager';
export {
  attachWorktreeSession,
  captureWorkInProgress,
  prepareWorktree,
  rehydrateWorktreeSession,
  restoreWorktreeSession,
  validateExistingWorktree,
  WORKTREE_DIR,
} from './create';
export {
  discardFreshWorktree,
  finishWorktree,
  removeWorktree,
  retireWorktreeSnapshot,
} from './finish';
export { canonical, git, gitText, repositoryRoot } from './git';
export type {
  BranchReview,
  BranchReviewMode,
  BranchReviewOptions,
  BranchReviewPathSummary,
  BranchState,
  MergeOutcome,
} from './integrate';
export { branchState, mergeBranch, reviewBranch } from './integrate';
export type {
  PreparedWorktree,
  WorktreeBase,
  WorktreeOwnership,
  WorktreePreparation,
  WorktreeRecord,
  WorktreeRunOutcome,
  WorktreeStatus,
  WorktreeSummary,
} from './model';
export { workBase, worktreeSummary } from './model';
export {
  deleteWorktreeRecord,
  listWorktrees,
  loadWorktree,
  touchWorktreeParentSession,
  writeWorktreeRecord,
} from './records';
