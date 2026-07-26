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
export type {
  PreparedWorktree,
  WorktreeBase,
  WorktreePreparation,
  WorktreeRecord,
  WorktreeStatus,
  WorktreeSummary,
} from './model';
export { worktreeSummary } from './model';
export {
  deleteWorktreeRecord,
  listWorktrees,
  loadWorktree,
  writeWorktreeRecord,
} from './records';
