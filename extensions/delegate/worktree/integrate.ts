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
import { listWorktrees, writeWorktreeRecord } from './records';

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
  if (
    record.integratedBy &&
    record.integratedHead &&
    record.integratedHead === record.headCommit
  )
    return Promise.resolve('merged');
  return integrator().branchState(record);
}

export function reviewBranch(
  record: WorktreeRecord,
  options?: BranchReviewMode | BranchReviewOptions,
): Promise<BranchReview> {
  return integrator().reviewBranch(record, options);
}

async function isAncestor(
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await worktreeGit.git(repositoryRoot, [
      'merge-base',
      '--is-ancestor',
      ancestor,
      descendant,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function markIntegratedAncestors(record: WorktreeRecord): Promise<void> {
  if (!record.headCommit) return;
  const integratedAt = new Date().toISOString();
  for (const candidate of listWorktrees()) {
    if (
      candidate.id === record.id ||
      candidate.repositoryRoot !== record.repositoryRoot ||
      candidate.status !== 'finished' ||
      candidate.snapshot ||
      candidate.ownership === 'caller' ||
      !candidate.headCommit ||
      candidate.integratedBy ||
      !(await isAncestor(
        record.repositoryRoot,
        candidate.headCommit,
        record.headCommit,
      ))
    )
      continue;
    candidate.integratedBy = record.id;
    candidate.integratedHead = candidate.headCommit;
    candidate.integratedAt = integratedAt;
    writeWorktreeRecord(candidate);
  }
}

export async function mergeBranch(
  record: WorktreeRecord,
): Promise<MergeOutcome> {
  const cumulative = record.integrationBase;
  const outcome = await integrator().mergeBranch(
    cumulative && cumulative !== record.carryCommit
      ? { ...record, carryCommit: cumulative }
      : record,
  );
  if (outcome.merged) await markIntegratedAncestors(record);
  return outcome;
}
