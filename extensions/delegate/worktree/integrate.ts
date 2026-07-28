/**
 * Fan-in for delegated work.
 *
 * Worktrees let writable tasks fan out without colliding; every one of them
 * ends as a branch somebody has to review and merge. The parent can do that
 * with ordinary git. A `from: 'wip'` branch has one extra boundary: its carry
 * commit holds the parent's uncommitted work, while commits after that carry
 * are the delegate's work. Integration preserves that boundary rather than
 * merging the carry snapshot back into the still-dirty parent checkout.
 */
import { git, gitText, splitZ } from './git';
import { type WorktreeRecord, workBase } from './model';

const MAX_REVIEW_DIFF_CHARS = 60_000;

export type BranchState =
  /** No delegate work from this branch remains to apply to HEAD. */
  | 'merged'
  /** The branch has delegate work the repository's HEAD does not. */
  | 'unmerged'
  /** No branch by that name; it was dropped or renamed. */
  | 'gone';

async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function paths(cwd: string, args: string[]): Promise<string[]> {
  return splitZ(String(await git(cwd, args)));
}

function workRange(record: WorktreeRecord): string {
  return `${workBase(record)}..${record.branch}`;
}

/**
 * A carried branch is integrated by cherry-picking only its task commits, so
 * its tip is intentionally not an ancestor afterwards. `git cherry` compares
 * those commits by patch identity and lets the branch still behave as merged.
 */
async function carriedWorkIsApplied(
  root: string,
  record: WorktreeRecord,
): Promise<boolean> {
  const output = await gitText(root, [
    'cherry',
    'HEAD',
    record.branch,
    workBase(record),
  ]);
  return !output.split('\n').some((line) => line.startsWith('+ '));
}

export async function branchState(
  record: WorktreeRecord,
): Promise<BranchState> {
  const root = record.repositoryRoot;
  if (
    !(await succeeds(root, ['rev-parse', '--verify', '--quiet', record.branch]))
  )
    return 'gone';
  if (
    await succeeds(root, ['merge-base', '--is-ancestor', record.branch, 'HEAD'])
  )
    return 'merged';
  return record.carryCommit && (await carriedWorkIsApplied(root, record))
    ? 'merged'
    : 'unmerged';
}

/** Paths with uncommitted changes in the parent checkout, tracked or not. */
async function dirtyPaths(root: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    paths(root, ['diff', '--name-only', '-z', 'HEAD']),
    paths(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return [...new Set([...tracked, ...untracked])];
}

export interface BranchReview {
  state: BranchState;
  /** The agent's own commits, excluding any carried parent work. */
  log: string;
  stat: string;
  diff: string;
  truncated: boolean;
}

/**
 * Everything needed to judge the work in one call: the agent's commits, what
 * they touched, and the diff — measured from the carry commit, so the parent is
 * never shown its own uncommitted changes as if the agent had written them.
 */
export async function reviewBranch(
  record: WorktreeRecord,
): Promise<BranchReview> {
  const root = record.repositoryRoot;
  const state = await branchState(record);
  if (state === 'gone')
    return { state, log: '', stat: '', diff: '', truncated: false };
  const range = workRange(record);
  const [log, stat, full] = await Promise.all([
    gitText(root, ['log', '--oneline', '--no-decorate', range]),
    gitText(root, ['diff', '--stat', range]),
    gitText(root, ['diff', range]),
  ]);
  const truncated = full.length > MAX_REVIEW_DIFF_CHARS;
  return {
    state,
    log,
    stat,
    diff: truncated ? full.slice(0, MAX_REVIEW_DIFF_CHARS) : full,
    truncated,
  };
}

export interface MergeOutcome {
  merged: boolean;
  /** Why the merge was refused or failed; absent on success. */
  reason?: string;
  conflicted?: string[];
  blockedPaths?: string[];
  /** The parent HEAD commit after successful integration. */
  commit?: string;
}

/**
 * Merge a delegate branch into the parent checkout.
 *
 * Either integration lands or the checkout is left exactly as it was: a
 * conflict is aborted rather than parked, because an agent that continues
 * working from a half-merged tree makes a worse mess than one told to resolve
 * deliberately. A carried branch cherry-picks only `workBase..branch`; a
 * normal branch keeps the ordinary no-fast-forward merge.
 */
export async function mergeBranch(
  record: WorktreeRecord,
): Promise<MergeOutcome> {
  const root = record.repositoryRoot;
  const state = await branchState(record);
  if (state === 'gone')
    return {
      merged: false,
      reason: `Branch ${record.branch} no longer exists.`,
    };
  if (state === 'merged')
    return {
      merged: false,
      reason: record.carryCommit
        ? `${record.branch}'s task commits are already applied to HEAD; there is nothing to merge.`
        : `${record.branch} is already an ancestor of HEAD; there is nothing to merge.`,
    };
  if (await succeeds(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']))
    return {
      merged: false,
      reason:
        'The repository is mid-merge. Finish or abort that merge before integrating delegated work.',
    };
  if (
    await succeeds(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      'CHERRY_PICK_HEAD',
    ])
  )
    return {
      merged: false,
      reason:
        'The repository is mid-cherry-pick. Finish or abort that cherry-pick before integrating delegated work.',
    };

  const range = workRange(record);
  const [dirty, incoming] = await Promise.all([
    dirtyPaths(root),
    paths(root, ['diff', '--name-only', '-z', range]),
  ]);
  const blockedPaths = incoming.filter((file) => dirty.includes(file));
  if (blockedPaths.length > 0)
    return {
      merged: false,
      blockedPaths,
      reason: `These paths are uncommitted here and also changed by the task on ${record.branch}: commit or stash them first.`,
    };

  const cherryPick = Boolean(record.carryCommit);
  try {
    await git(
      root,
      cherryPick
        ? ['cherry-pick', '--no-edit', range]
        : ['merge', '--no-ff', '--no-edit', record.branch],
    );
    return { merged: true, commit: await gitText(root, ['rev-parse', 'HEAD']) };
  } catch (error) {
    const conflicted = await paths(root, [
      'diff',
      '--name-only',
      '--diff-filter=U',
      '-z',
    ]).catch(() => []);
    await git(
      root,
      cherryPick ? ['cherry-pick', '--abort'] : ['merge', '--abort'],
    ).catch(() => undefined);
    const command = cherryPick
      ? `git cherry-pick ${range}`
      : `git merge ${record.branch}`;
    return {
      merged: false,
      conflicted,
      reason: conflicted.length
        ? `Integration conflicted and was aborted; your checkout is unchanged. Resolve deliberately with: ${command}`
        : `Integration failed and was aborted; your checkout is unchanged: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
