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

// Branch detail is combined with the independently bounded review sections in
// delegate_branches review. Keep every record-derived field bounded here too, so
// the complete response has a deterministic upper bound while retaining the
// first useful path evidence and an explicit omission count.
const MAX_DETAIL_FIELD_CHARS = 512;
const MAX_DETAIL_ERROR_CHARS = 2_000;
const MAX_DETAIL_PATH_CHARS = 256;
const MAX_DETAIL_PATHS = 40;

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function changedCount(record: WorktreeRecord): string {
  const changed = record.changedPaths ?? [];
  return changed.length === 1 ? '1 path' : `${changed.length} paths`;
}

function changedDetail(record: WorktreeRecord): string {
  const changed = record.changedPaths ?? [];
  if (!changed.length) return 'Changed:   nothing committed by the task';
  const shown = changed
    .slice(0, MAX_DETAIL_PATHS)
    .map((name) => `  - ${bounded(name, MAX_DETAIL_PATH_CHARS)}`);
  const omitted = changed.length - shown.length;
  if (omitted > 0)
    shown.push(`  - … and ${omitted} more paths (path list bounded)`);
  return `Changed:   ${changedCount(record)}\n${shown.join('\n')}`;
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
  const id = bounded(record.id, MAX_DETAIL_FIELD_CHARS);
  return [
    `Read-only snapshot: ${id} (checkout retired)`,
    `Cleanup: delegate_branches drop ${id}`,
    'Continue with its continuation token without refresh to rehydrate this exact source.',
    'Use refresh wip or head only for targeted verification; it is not independent review.',
  ].join('\n');
}

export function formatBranchDetail({ record, state }: BranchEntry): string {
  if (record.snapshot) return snapshotGuidance(record);
  return [
    `Branch:    ${bounded(record.branch, MAX_DETAIL_FIELD_CHARS)} (${bounded(state, MAX_DETAIL_FIELD_CHARS)})`,
    `Worktree:  ${bounded(record.worktreePath, MAX_DETAIL_FIELD_CHARS)}`,
    `Repo:      ${bounded(record.repositoryRoot, MAX_DETAIL_FIELD_CHARS)}`,
    `Base:      ${bounded(record.baseHead.slice(0, 12), MAX_DETAIL_FIELD_CHARS)} (${record.base})`,
    record.carryCommit
      ? `Carried:   ${bounded(record.carryCommit.slice(0, 12), MAX_DETAIL_FIELD_CHARS)} — your uncommitted work, committed so the task's own work is separable`
      : undefined,
    `Status:    ${bounded(record.status, MAX_DETAIL_FIELD_CHARS)}`,
    changedDetail(record),
    record.error
      ? `Note:      ${bounded(record.error, MAX_DETAIL_ERROR_CHARS)}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

export function formatReview(
  record: WorktreeRecord,
  review: BranchReview,
): string {
  const branch = bounded(record.branch, MAX_DETAIL_FIELD_CHARS);
  const repository = bounded(record.repositoryRoot, MAX_DETAIL_FIELD_CHARS);
  if (review.state === 'gone') return `Branch ${branch} no longer exists.`;
  if (review.error)
    return `${branch} (${bounded(review.state, MAX_DETAIL_FIELD_CHARS)})\n\n${bounded(review.error, MAX_DETAIL_ERROR_CHARS)}`;
  if (review.mode === 'incremental' && !review.log)
    return `${branch} (${bounded(review.state, MAX_DETAIL_FIELD_CHARS)}) has no unintegrated task delta relative to current HEAD.`;
  if (!review.log)
    return `${branch} (${bounded(review.state, MAX_DETAIL_FIELD_CHARS)}) has no commits of its own beyond ${workBase(record).slice(0, 12)}; the task committed nothing.`;
  const range =
    review.mode === 'incremental'
      ? `incremental task delta relative to current HEAD (patch-aware)`
      : `${workBase(record).slice(0, 12)}..${branch}`;
  const truncation = review.truncated
    ? review.mode === 'incremental'
      ? `\n[review truncated — log/stat/diff output is bounded; inspect the complete task branch with: git -C ${repository} log --oneline ${workBase(record)}..${branch}]`
      : `\n[review truncated — log/stat/diff output is bounded; inspect the complete review with: git -C ${repository} log --oneline ${workBase(record)}..${branch} and git -C ${repository} diff ${workBase(record)}..${branch}]`
    : '';
  return [
    `${branch} (${bounded(review.state, MAX_DETAIL_FIELD_CHARS)}), ${range}`,
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
