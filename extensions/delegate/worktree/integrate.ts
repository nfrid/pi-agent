/** Stable delegate import surface for shared review and integration mechanics. */

import type {
  BranchReview,
  BranchReviewMode,
  BranchReviewOptions,
  BranchReviewPathSummary,
  BranchState,
  MergeOutcome,
} from '@pi-dashboard/worktree-manager';
import { createWorktreeIntegrator } from '@pi-dashboard/worktree-manager';
import * as worktreeGit from './git';
import type { WorktreeRecord } from './model';

export type {
  BranchReview,
  BranchReviewMode,
  BranchReviewOptions,
  BranchReviewPathSummary,
  BranchState,
  MergeOutcome,
};

function integrator() {
  return createWorktreeIntegrator({
    git: worktreeGit.git,
    gitText: worktreeGit.gitText,
  });
}

export function branchState(record: WorktreeRecord): Promise<BranchState> {
  return integrator().branchState(record);
}

export function reviewBranch(
  record: WorktreeRecord,
  options?: BranchReviewMode | BranchReviewOptions,
): Promise<BranchReview> {
  return integrator().reviewBranch(record, options);
}

export function mergeBranch(record: WorktreeRecord): Promise<MergeOutcome> {
  const cumulative = record.integrationBase;
  return integrator().mergeBranch(
    cumulative && cumulative !== record.carryCommit
      ? { ...record, carryCommit: cumulative }
      : record,
  );
}
