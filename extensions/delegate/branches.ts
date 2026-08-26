/**
 * Shared reporting for delegate branches, used by both the agent-facing
 * `delegate_changes` tool and the `/delegate-worktrees` command so the two
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

export type BranchListScope = 'session' | 'all';

function belongsToParentSession(
  record: WorktreeRecord,
  sessionId: string,
): boolean {
  return (
    record.creatorSessionId === sessionId ||
    record.recentParentSessionIds?.includes(sessionId) === true ||
    // Records written by the previous implementation remain visible in the
    // session view until they are touched again or explicitly listed as all.
    record.parentSessionIds?.includes(sessionId) === true
  );
}

/** Accepts a continuation token or a worktree id; the agent has both. */
export function resolveWorktreeRecord(
  identifier: string,
): WorktreeRecord | undefined {
  const session = resolveDelegateSession(identifier);
  return loadWorktree(session?.worktreeId ?? identifier);
}

export async function listBranchEntries(
  options: { scope?: BranchListScope; sessionId?: string } = {},
): Promise<BranchEntry[]> {
  const scope = options.scope ?? 'session';
  // An absent session identity cannot safely mean "all history". This also
  // makes an empty current-session inventory explicit instead of falling back.
  const records =
    scope === 'all'
      ? listWorktrees()
      : options.sessionId
        ? listWorktrees().filter((record) =>
            belongsToParentSession(record, options.sessionId as string),
          )
        : [];
  return Promise.all(
    records.map(async (record) => ({
      record,
      state: await branchState(record),
    })),
  );
}

// Branch detail is combined with the independently bounded review sections in
// delegate_changes review. Keep every record-derived field bounded here too, so
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
    record.ownership === 'caller' ? 'caller-owned' : record.branch,
    record.ownership === 'caller'
      ? `${record.branch} (${changedCount(record)})`
      : changedCount(record),
  ].join('  ');
}

export function snapshotGuidance(record: WorktreeRecord): string {
  const id = bounded(record.id, MAX_DETAIL_FIELD_CHARS);
  return [
    `Read-only snapshot: ${id} (checkout retired)`,
    `Cleanup: /delegate-worktrees ${id} drop`,
    'Continue with its continuation token without refresh to rehydrate this exact source.',
    'Use refresh wip or head only for targeted verification; it is not independent review.',
  ].join('\n');
}

export function formatBranchDetail({ record, state }: BranchEntry): string {
  if (record.snapshot) return snapshotGuidance(record);
  return [
    record.ownership === 'caller'
      ? 'Ownership: caller-provided (checkout and branch remain caller-managed)'
      : undefined,
    `Branch:    ${bounded(record.branch, MAX_DETAIL_FIELD_CHARS)} (${bounded(state, MAX_DETAIL_FIELD_CHARS)})`,
    `Worktree:  ${bounded(record.worktreePath, MAX_DETAIL_FIELD_CHARS)}`,
    `Repo:      ${bounded(record.repositoryRoot, MAX_DETAIL_FIELD_CHARS)}`,
    `Base:      ${bounded(record.baseHead.slice(0, 12), MAX_DETAIL_FIELD_CHARS)} (${record.base})`,
    record.carryCommit
      ? `Carried:   ${bounded(record.carryCommit.slice(0, 12), MAX_DETAIL_FIELD_CHARS)} — your uncommitted work, committed so the task's own work is separable`
      : undefined,
    `Status:    ${bounded(record.status, MAX_DETAIL_FIELD_CHARS)}`,
    changedDetail(record),
    record.ownership === 'caller'
      ? 'Integration: delegate_changes merge is disabled; merge or manage this branch in the caller checkout.'
      : undefined,
    record.error
      ? `Note:      ${bounded(record.error, MAX_DETAIL_ERROR_CHARS)}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function hasBoundedReviewSelectors(review: BranchReview): boolean {
  return (
    review.summaryOnly === true ||
    Boolean(review.pathSelectors?.length) ||
    review.patchBudget !== undefined
  );
}

function reviewSelectionSummary(review: BranchReview): string {
  const selectors = review.pathSelectors?.length
    ? review.pathSelectors
        .slice(0, MAX_DETAIL_PATHS)
        .map((selector) => bounded(selector, MAX_DETAIL_PATH_CHARS))
        .join(', ')
    : 'none';
  const budget = review.patchBudget
    ? `${review.patchBudget} chars`
    : 'default (60,000 chars)';
  const summary = review.pathSummary;
  if (!summary)
    return [
      `Selectors: mode=${review.mode}; summaryOnly=${review.summaryOnly ? 'yes' : 'no'}; paths=${selectors}; patchBudget=${budget}`,
      `Patch: ${review.summaryOnly ? 'body omitted (summaryOnly)' : `budget=${budget}; truncated=${review.patchTruncated ? 'yes' : 'no'}; omitted=${review.omittedPatchChars ?? 0} chars`}`,
    ].join('\n');
  const matched = summary.matchedPaths
    .slice(0, MAX_DETAIL_PATHS)
    .map((path) => `  - ${bounded(path, MAX_DETAIL_PATH_CHARS)}`);
  const omitted = summary.omittedPaths
    .slice(0, MAX_DETAIL_PATHS)
    .map((path) => `  - ${bounded(path, MAX_DETAIL_PATH_CHARS)}`);
  if (summary.matched > matched.length)
    matched.push(
      `  - … and ${summary.matched - matched.length} more matched paths (path list bounded)`,
    );
  if (summary.omitted > omitted.length)
    omitted.push(
      `  - … and ${summary.omitted - omitted.length} more omitted paths (path list bounded)`,
    );
  return [
    `Selectors: mode=${review.mode}; summaryOnly=${review.summaryOnly ? 'yes' : 'no'}; paths=${selectors}; patchBudget=${budget}`,
    `Patch: ${review.summaryOnly ? 'body omitted (summaryOnly)' : `budget=${budget}; truncated=${review.patchTruncated ? 'yes' : 'no'}; omitted=${review.omittedPatchChars ?? 0} chars`}`,
    `Changed paths: total=${summary.total}; matched=${summary.matched}; omitted=${summary.omitted}`,
    `Matched paths:${matched.length ? `\n${matched.join('\n')}` : ' none'}`,
    `Omitted paths:${omitted.length ? `\n${omitted.join('\n')}` : ' none'}`,
  ].join('\n');
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
  const boundedView = hasBoundedReviewSelectors(review);
  const selection = boundedView ? reviewSelectionSummary(review) : undefined;
  if (review.mode === 'incremental' && !review.log) {
    const message = `${branch} (${bounded(review.state, MAX_DETAIL_FIELD_CHARS)}) has no unintegrated task delta relative to current HEAD.`;
    return selection ? `${message}\n\n${selection}` : message;
  }
  if (!review.log) {
    const message = `${branch} (${bounded(review.state, MAX_DETAIL_FIELD_CHARS)}) has no commits of its own beyond ${workBase(record).slice(0, 12)}; the task committed nothing.`;
    return selection ? `${message}\n\n${selection}` : message;
  }
  const range =
    review.mode === 'incremental'
      ? `incremental task delta relative to current HEAD (patch-aware)`
      : `${workBase(record).slice(0, 12)}..${branch}`;
  const truncation = review.truncated
    ? review.mode === 'incremental'
      ? `\n[review truncated — log/stat/diff output is bounded${review.patchBudget ? `; patch budget=${review.patchBudget} chars` : ''}; inspect the complete task branch with: git -C ${repository} log --oneline ${workBase(record)}..${branch}]`
      : `\n[review truncated — log/stat/diff output is bounded${review.patchBudget ? `; patch budget=${review.patchBudget} chars` : ''}; inspect the complete review with: git -C ${repository} log --oneline ${workBase(record)}..${branch} and git -C ${repository} diff ${workBase(record)}..${branch}]`
    : '';
  const patch = review.summaryOnly
    ? '[patch body omitted — summaryOnly is active]'
    : review.diff;
  return [
    `${branch} (${bounded(review.state, MAX_DETAIL_FIELD_CHARS)}), ${range}`,
    '',
    ...(selection ? [selection, ''] : []),
    review.log,
    '',
    review.stat,
    '',
    patch,
    truncation,
  ]
    .join('\n')
    .trimEnd();
}
