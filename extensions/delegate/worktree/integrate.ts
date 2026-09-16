/** Stable delegate import surface for shared review and integration mechanics. */

import type {
  BranchReview,
  BranchReviewMode,
  BranchReviewOptions,
  BranchReviewPathSummary,
  BranchState,
  MergeOptions,
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
  MergeOptions,
  MergeOutcome,
};

function integrator() {
  return createWorktreeIntegrator({
    git: worktreeGit.git,
    gitText: worktreeGit.gitText,
  });
}

export async function branchState(
  record: WorktreeRecord,
): Promise<BranchState> {
  if (
    record.integratedBy &&
    record.integratedHead &&
    record.integratedHead === record.headCommit &&
    (!record.integratedCommit ||
      (await isAncestor(
        record.repositoryRoot,
        record.integratedCommit,
        'HEAD',
      )))
  )
    return 'merged';
  return integrator().branchState(record);
}

export async function reviewBranch(
  record: WorktreeRecord,
  options?: BranchReviewMode | BranchReviewOptions,
): Promise<BranchReview> {
  const incremental =
    options === 'incremental' ||
    (typeof options === 'object' &&
      (options.mode === 'incremental' || options.incremental === true));
  const boundary = incremental ? await squashBoundary(record) : undefined;
  return integrator().reviewBranch(
    boundary ? { ...record, carryCommit: boundary } : record,
    options,
  );
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

async function squashBoundary(
  record: WorktreeRecord,
): Promise<string | undefined> {
  const boundaries: string[] = [];
  const consider = async (
    boundary: string | undefined,
    integratedCommit: string | undefined,
  ): Promise<void> => {
    if (!boundary) return;
    if (
      integratedCommit &&
      !(await isAncestor(record.repositoryRoot, integratedCommit, 'HEAD'))
    )
      return;
    if (
      !(await isAncestor(record.repositoryRoot, boundary, record.branch)) ||
      boundaries.includes(boundary)
    )
      return;
    boundaries.push(boundary);
  };

  await consider(
    record.integratedHead ??
      (record.integratedCommit ? record.integrationBoundary : undefined),
    record.integratedCommit,
  );
  for (const candidate of listWorktrees()) {
    if (
      candidate.id === record.id ||
      candidate.repositoryRoot !== record.repositoryRoot ||
      candidate.status !== 'finished' ||
      candidate.snapshot ||
      candidate.ownership === 'caller'
    )
      continue;
    await consider(candidate.integratedHead, candidate.integratedCommit);
  }

  let selected: string | undefined;
  for (const boundary of boundaries) {
    if (
      !selected ||
      (await isAncestor(record.repositoryRoot, selected, boundary))
    )
      selected = boundary;
  }
  return selected;
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
      !(await isAncestor(
        record.repositoryRoot,
        candidate.headCommit,
        record.headCommit,
      ))
    )
      continue;
    candidate.integratedBy = record.id;
    candidate.integratedHead = candidate.headCommit;
    if (record.integratedCommit)
      candidate.integratedCommit = record.integratedCommit;
    else delete candidate.integratedCommit;
    candidate.integratedAt = integratedAt;
    writeWorktreeRecord(candidate);
  }
}

export async function mergeBranch(
  record: WorktreeRecord,
  options?: MergeOptions,
): Promise<MergeOutcome> {
  const cumulative = record.integrationBase;
  const priorSquashBoundary =
    options?.commitMessage !== undefined
      ? await squashBoundary(record)
      : undefined;
  const effectiveRecord = priorSquashBoundary
    ? {
        ...record,
        carryCommit: priorSquashBoundary,
      }
    : cumulative && cumulative !== record.carryCommit
      ? { ...record, carryCommit: cumulative }
      : record;
  const outcome = await integrator().mergeBranch(effectiveRecord, options);
  if (outcome.merged) {
    if (record.headCommit && outcome.commit) {
      record.integratedBy = record.id;
      record.integratedHead = record.headCommit;
      record.integratedCommit = outcome.commit;
      record.integratedAt = new Date().toISOString();
      writeWorktreeRecord(record);
    }
    await markIntegratedAncestors(record);
  }
  return outcome;
}
