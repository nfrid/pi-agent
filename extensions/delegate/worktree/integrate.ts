/**
 * Fan-in for delegated work.
 *
 * Worktrees let writable tasks fan out without colliding; every one of them
 * ends as a branch somebody has to review and merge. The parent can do that
 * with ordinary git — but the default `from: 'wip'` path has a trap that plain
 * git reports obscurely: the branch carries the parent's own uncommitted work,
 * so merging it back into a checkout where that work is *still* uncommitted
 * fails with a message about local changes being overwritten. These helpers
 * name that situation instead of leaving it to be rediscovered.
 */
import { git, gitText, splitZ } from './git';
import { type WorktreeRecord, workBase } from './model';

const MAX_REVIEW_DIFF_CHARS = 60_000;

export type BranchState =
  /** The branch tip is an ancestor of the repository's HEAD. */
  | 'merged'
  /** The branch has commits the repository's HEAD does not. */
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

export async function branchState(
  record: WorktreeRecord,
): Promise<BranchState> {
  const root = record.repositoryRoot;
  if (
    !(await succeeds(root, ['rev-parse', '--verify', '--quiet', record.branch]))
  )
    return 'gone';
  return (await succeeds(root, [
    'merge-base',
    '--is-ancestor',
    record.branch,
    'HEAD',
  ]))
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
  const range = `${workBase(record)}..${record.branch}`;
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
  /** The merge commit, on success. */
  commit?: string;
}

/**
 * Merge a delegate branch into the parent checkout.
 *
 * Either the merge lands or the checkout is left exactly as it was: a conflict
 * is aborted rather than parked, because an agent that continues working from a
 * half-merged tree makes a worse mess than one told to resolve deliberately.
 * `--no-ff` keeps the delegated work identifiable as a merge and stops the
 * parent's HEAD from silently fast-forwarding onto the carry commit.
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
      reason: `${record.branch} is already an ancestor of HEAD; there is nothing to merge.`,
    };
  if (await succeeds(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']))
    return {
      merged: false,
      reason:
        'The repository is mid-merge. Finish or abort that merge before integrating delegated work.',
    };

  const [dirty, incoming] = await Promise.all([
    dirtyPaths(root),
    paths(root, [
      'diff',
      '--name-only',
      '-z',
      `${record.baseHead}..${record.branch}`,
    ]),
  ]);
  const blockedPaths = incoming.filter((file) => dirty.includes(file));
  if (blockedPaths.length > 0)
    return {
      merged: false,
      blockedPaths,
      reason: record.carriedWip
        ? `These paths are uncommitted here and also changed on ${record.branch}: git would overwrite them. The branch carries your uncommitted work, so this is expected — commit or stash it, then merge.`
        : `These paths are uncommitted here and also changed on ${record.branch}: commit or stash them first.`,
    };

  try {
    await git(root, ['merge', '--no-ff', '--no-edit', record.branch]);
    return { merged: true, commit: await gitText(root, ['rev-parse', 'HEAD']) };
  } catch (error) {
    const conflicted = await paths(root, [
      'diff',
      '--name-only',
      '--diff-filter=U',
      '-z',
    ]).catch(() => []);
    await git(root, ['merge', '--abort']).catch(() => undefined);
    return {
      merged: false,
      conflicted,
      reason: conflicted.length
        ? `Merge conflicted and was aborted; your checkout is unchanged. Resolve deliberately with: git merge ${record.branch}`
        : `Merge failed and was aborted; your checkout is unchanged: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
