/**
 * Generic Git/worktree lifecycle mechanics.
 *
 * Callers provide persistence through WorktreeStore; this package owns only
 * checkout creation, WIP carrying, lifecycle settlement, review, integration,
 * and retirement.
 */
export {
  createWorktreeCreator,
  WORKTREE_DIR,
  type WorktreeCreator,
  type WorktreeCreatorOptions,
} from './create';
export {
  createWorktreeFinisher,
  type WorktreeFinisher,
  type WorktreeFinisherOptions,
} from './finish';
export {
  canonical,
  git,
  gitText,
  isInside,
  repositoryIdentity,
  repositoryRoot,
  splitZ,
} from './git';
export type {
  BranchReview,
  BranchReviewMode,
  BranchReviewOptions,
  BranchReviewPathSummary,
  BranchState,
  MergeOutcome,
  WorktreeGit,
  WorktreeIntegrator,
} from './integrate';
export {
  branchState,
  createWorktreeIntegrator,
  MAX_REVIEW_PATCH_BUDGET,
  mergeBranch,
  reviewBranch,
} from './integrate';
export type {
  PreparedWorktree,
  WorktreeBase,
  WorktreePreparation,
  WorktreeRecord,
  WorktreeRunOutcome,
  WorktreeStatus,
  WorktreeSummary,
} from './model';
export { workBase, worktreeSummary } from './model';
export type { WorktreeStore } from './store';
