/**
 * Generic Git/worktree lifecycle mechanics.
 *
 * Callers provide persistence through WorktreeStore; this package owns only
 * checkout creation, WIP carrying, lifecycle settlement, review, integration,
 * and retirement.
 */
export {
  createWorktreeCreator,
  type ExistingWorktreeValidation,
  validateExistingWorktree,
  WORKTREE_DIR,
  type WorktreeCreator,
  type WorktreeCreatorOptions,
  withWorktreePathLock,
} from './create.js';
export {
  createWorktreeFinisher,
  type WorktreeFinisher,
  type WorktreeFinisherOptions,
} from './finish.js';
export {
  canonical,
  git,
  gitText,
  isInside,
  repositoryIdentity,
  repositoryRoot,
  splitZ,
} from './git.js';
export type {
  BranchReview,
  BranchReviewMode,
  BranchReviewOptions,
  BranchReviewPathSummary,
  BranchState,
  MergeOutcome,
  WorktreeGit,
  WorktreeIntegrator,
} from './integrate.js';
export {
  branchState,
  createWorktreeIntegrator,
  MAX_REVIEW_PATCH_BUDGET,
  mergeBranch,
  reviewBranch,
} from './integrate.js';
export type {
  PreparedWorktree,
  WorktreeBase,
  WorktreeOwnership,
  WorktreePreparation,
  WorktreeRecord,
  WorktreeRunOutcome,
  WorktreeStatus,
  WorktreeSummary,
} from './model.js';
export { workBase, worktreeSummary } from './model.js';
export type { WorktreeStore } from './store.js';
