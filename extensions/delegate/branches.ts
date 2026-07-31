/**
 * Shared reporting for delegate branches, used by both the agent-facing
 * `delegate_branches` tool and the `/delegate-worktrees` command so the two
 * never drift into describing the same branch differently.
 */
import { resolveDelegateSession } from './session';
import {
  type BranchReview,
  type BranchState,
  branchState,
  listWorktrees,
  loadWorktree,
  type WorktreeRecord,
  workBase,
} from './worktree';

export interface BranchEntry {
  record: WorktreeRecord;
  state: BranchState;
}

/** Accepts a continuation token or a worktree id; the agent has both. */
export function resolveWorktreeRecord(
  identifier: string,
): WorktreeRecord | undefined {
  const session = resolveDelegateSession(identifier);
  return loadWorktree(session?.worktreeId ?? identifier);
}

export async function listBranchEntries(): Promise<BranchEntry[]> {
  const records = listWorktrees();
  return Promise.all(
    records.map(async (record) => ({
      record,
      state: await branchState(record),
    })),
  );
}

function changedCount(record: WorktreeRecord): string {
  const changed = record.changedPaths ?? [];
  return changed.length === 1 ? '1 path' : `${changed.length} paths`;
}

export function formatBranchLine({ record, state }: BranchEntry): string {
  if (record.snapshot)
    return [
      record.id,
      'snapshot'.padEnd(8),
      record.status.padEnd(8),
      'read-only snapshot (checkout retired)',
    ].join('  ');
  return [
    record.id,
    state.padEnd(8),
    record.status.padEnd(8),
    record.branch,
    changedCount(record),
  ].join('  ');
}

export function snapshotGuidance(record: WorktreeRecord): string {
  return [
    `Read-only snapshot: ${workBase(record).slice(0, 12)} (checkout retired)`,
    'Continue with its continuation token without refresh to rehydrate this exact source.',
    'Use refresh wip or head only for targeted verification; it is not independent review.',
    `Drop: delegate_branches drop ${record.id}`,
  ].join('\n');
}

export function formatBranchDetail({ record, state }: BranchEntry): string {
  if (record.snapshot) return snapshotGuidance(record);
  const changed = record.changedPaths ?? [];
  return [
    `Branch:    ${record.branch} (${state})`,
    `Worktree:  ${record.worktreePath}`,
    `Repo:      ${record.repositoryRoot}`,
    `Base:      ${record.baseHead.slice(0, 12)} (${record.base})`,
    record.carryCommit
      ? `Carried:   ${record.carryCommit.slice(0, 12)} — your uncommitted work, committed so the task's own work is separable`
      : undefined,
    `Status:    ${record.status}`,
    changed.length
      ? `Changed:   ${changedCount(record)}\n${changed.map((name) => `  - ${name}`).join('\n')}`
      : 'Changed:   nothing committed by the task',
    record.error ? `Note:      ${record.error}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

export function formatReview(
  record: WorktreeRecord,
  review: BranchReview,
): string {
  if (review.state === 'gone')
    return `Branch ${record.branch} no longer exists.`;
  if (review.error)
    return `${record.branch} (${review.state})\n\n${review.error}`;
  if (review.mode === 'incremental' && !review.log)
    return `${record.branch} (${review.state}) has no unintegrated task delta relative to current HEAD.`;
  if (!review.log)
    return `${record.branch} (${review.state}) has no commits of its own beyond ${workBase(record).slice(0, 12)}; the task committed nothing.`;
  const range =
    review.mode === 'incremental'
      ? `incremental task delta relative to current HEAD (patch-aware)`
      : `${workBase(record).slice(0, 12)}..${record.branch}`;
  const truncation = review.truncated
    ? review.mode === 'incremental'
      ? `\n[diff truncated — rerun delegate_branches review ${record.id} with incremental: true]`
      : `\n[diff truncated — read the rest with: git -C ${record.repositoryRoot} diff ${workBase(record)}..${record.branch}]`
    : '';
  return [
    `${record.branch} (${review.state}), ${range}`,
    '',
    review.log,
    '',
    review.stat,
    '',
    review.diff,
    truncation,
  ]
    .join('\n')
    .trimEnd();
}
