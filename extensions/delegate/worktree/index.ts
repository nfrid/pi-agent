/**
 * Seamless git worktrees for parallel delegated work.
 *
 * A writable delegate gets its own checkout on a real named branch. Setup needs
 * no per-repo hooks: dependencies are linked, gitignored essentials are copied,
 * and the parent's uncommitted work is carried in by default. When the run ends
 * the branch holds the work, and the orchestrator integrates it with ordinary
 * git rather than a bespoke patch protocol.
 */
export {
  attachWorktreeSession,
  prepareWorktree,
  restoreWorktreeSession,
  WORKTREE_DIR,
} from './create';
export {
  discardFreshWorktree,
  finishWorktree,
  removeWorktree,
} from './finish';
export { git, gitText, repositoryRoot } from './git';
export type { BranchReview, BranchState, MergeOutcome } from './integrate';
export { branchState, mergeBranch, reviewBranch } from './integrate';
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
export {
  deleteWorktreeRecord,
  listWorktrees,
  loadWorktree,
  writeWorktreeRecord,
} from './records';
