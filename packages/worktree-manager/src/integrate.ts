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
import { git as defaultGit, gitText as defaultGitText, splitZ } from './git.js';
import { type WorktreeRecord, workBase } from './model.js';

const MAX_REVIEW_DIFF_CHARS = 60_000;
// Keep the complete review bounded even when a branch has a large commit
// history or many changed paths. The diff keeps its historical 60k cap;
// log/stat get their own deterministic caps so no single section can make the
// tool result unbounded.
const MAX_REVIEW_LOG_CHARS = 20_000;
const MAX_REVIEW_STAT_CHARS = 20_000;
export const MAX_REVIEW_PATCH_BUDGET = MAX_REVIEW_DIFF_CHARS;
const MAX_REVIEW_PATHS = 80;
const MAX_REVIEW_SELECTOR_CHARS = 4_096;
const MAX_REVIEW_SELECTOR_TOTAL_CHARS = 16_384;

export interface WorktreeGit {
  git: typeof defaultGit;
  gitText: typeof defaultGitText;
}

export interface WorktreeIntegrator {
  branchState(record: WorktreeRecord): Promise<BranchState>;
  reviewBranch(
    record: WorktreeRecord,
    options?: BranchReviewMode | BranchReviewOptions,
  ): Promise<BranchReview>;
  mergeBranch(record: WorktreeRecord): Promise<MergeOutcome>;
}

export interface BranchReviewPathSummary {
  /** Number of changed paths in the unfiltered review range. */
  total: number;
  /** Number of paths selected for this view. */
  matched: number;
  /** Number omitted by the active path selector. */
  omitted: number;
  /** Bounded evidence for selected paths. */
  matchedPaths: string[];
  /** Bounded evidence for paths omitted by the selector. */
  omittedPaths: string[];
}

export interface BranchReview {
  state: BranchState;
  mode: BranchReviewMode;
  /** Why the recorded task range could not be inspected safely. */
  error?: string;
  /** The agent's own commits, excluding any carried parent work. */
  log: string;
  stat: string;
  diff: string;
  truncated: boolean;
  /** True when patch bodies were deliberately omitted. */
  summaryOnly?: boolean;
  /** Exact repository-relative path selectors active for this view. */
  pathSelectors?: string[];
  /** Caller-selected character budget, when supplied. */
  patchBudget?: number;
  /** Size before the patch-body budget was applied. */
  patchChars?: number;
  /** Patch-body characters omitted by the budget. */
  omittedPatchChars?: number;
  patchTruncated?: boolean;
  pathSummary?: BranchReviewPathSummary;
}

export interface BranchReviewOptions {
  mode?: BranchReviewMode;
  /** Convenience form for callers that expose the tool's boolean selector. */
  incremental?: boolean;
  /** Return provenance/stat/path evidence without patch bodies. */
  summaryOnly?: boolean;
  /** Exact repository-relative path selectors. */
  paths?: string[];
  /** Maximum patch-body characters; the default remains 60,000. */
  patchBudget?: number;
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

export type BranchReviewMode = 'full' | 'incremental';

export type BranchState =
  /** No delegate work from this branch remains to apply to HEAD. */
  | 'merged'
  /** The branch has delegate work the repository's HEAD does not. */
  | 'unmerged'
  /** No branch by that name; it was dropped or renamed. */
  | 'gone';

export function createWorktreeIntegrator(
  operations: WorktreeGit = { git: defaultGit, gitText: defaultGitText },
): WorktreeIntegrator {
  const { git, gitText } = operations;

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

  interface ValidWorkRange {
    valid: true;
    range: string;
    carried: boolean;
  }

  interface InvalidWorkRange {
    valid: false;
    error: string;
  }

  type WorkRangeResult = ValidWorkRange | InvalidWorkRange;

  function workRange(record: WorktreeRecord): string {
    return `${workBase(record)}..${record.branch}`;
  }

  function unsafeWorkRange(
    record: WorktreeRecord,
    detail: string,
    carried: boolean,
  ): InvalidWorkRange {
    const scope = carried
      ? 'it as a child-only range'
      : 'the recorded task range';
    return {
      valid: false,
      error: `Cannot safely inspect or integrate ${record.branch}: ${detail}. Refusing to use ${scope}; inspect it with: git log --oneline ${record.branch}`,
    };
  }

  /**
   * A rewritten branch can make its recorded base range mean an unrelated commit
   * set, so never pass that range to review, merge, or cherry-pick until Git
   * confirms the base still resolves and is an ancestor of the branch.
   */
  async function workRangeFor(
    root: string,
    record: WorktreeRecord,
  ): Promise<WorkRangeResult> {
    const carried = Boolean(record.carryCommit);
    if (!carried && record.carriedWip)
      return unsafeWorkRange(
        record,
        'the record says parent WIP was carried but no carry commit was recorded',
        true,
      );

    const base = workBase(record);
    const label = carried ? 'carry/work base' : 'base';
    if (
      !(await succeeds(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${base}^{commit}`,
      ]))
    )
      return unsafeWorkRange(
        record,
        `its recorded ${label} ${base.slice(0, 12)} no longer resolves`,
        carried,
      );
    if (
      !(await succeeds(root, [
        'merge-base',
        '--is-ancestor',
        base,
        record.branch,
      ]))
    )
      return unsafeWorkRange(
        record,
        `its recorded ${label} ${base.slice(0, 12)} is not an ancestor of the branch`,
        carried,
      );

    // `base..branch` is still unsafe after a reset back to base followed by an
    // unrelated replacement: base remains an ancestor of that replacement. A
    // finished record's last known branch tip is the lifecycle provenance that
    // distinguishes a legitimate continuation (which descends from it) from a
    // rewritten branch. Keep this check after base validation so malformed or
    // missing bases retain the more useful existing diagnostic.
    if (record.headCommit) {
      if (
        !(await succeeds(root, [
          'rev-parse',
          '--verify',
          '--quiet',
          `${record.headCommit}^{commit}`,
        ]))
      )
        return unsafeWorkRange(
          record,
          `its previously recorded head ${record.headCommit.slice(0, 12)} no longer resolves`,
          carried,
        );
      if (
        !(await succeeds(root, [
          'merge-base',
          '--is-ancestor',
          record.headCommit,
          record.branch,
        ]))
      )
        return unsafeWorkRange(
          record,
          `its previously recorded head ${record.headCommit.slice(0, 12)} is not an ancestor of the branch`,
          carried,
        );
    }

    return { valid: true, range: workRange(record), carried };
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

  async function hasTaskCommits(root: string, range: string): Promise<boolean> {
    return (await gitText(root, ['rev-list', '--count', range])) !== '0';
  }

  async function branchState(record: WorktreeRecord): Promise<BranchState> {
    const root = record.repositoryRoot;
    if (
      !(await succeeds(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        record.branch,
      ]))
    )
      return 'gone';
    const range = await workRangeFor(root, record);
    if (!range.valid) return 'unmerged';
    if (
      await succeeds(root, [
        'merge-base',
        '--is-ancestor',
        record.branch,
        'HEAD',
      ])
    )
      return 'merged';
    return range.carried && (await carriedWorkIsApplied(root, record))
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

  interface BranchReviewPathSummary {
    /** Number of changed paths in the unfiltered review range. */
    total: number;
    /** Number of paths selected for this view. */
    matched: number;
    /** Number omitted by the active path selector. */
    omitted: number;
    /** Bounded evidence for selected paths. */
    matchedPaths: string[];
    /** Bounded evidence for paths omitted by the selector. */
    omittedPaths: string[];
  }

  interface BranchReview {
    state: BranchState;
    mode: BranchReviewMode;
    /** Why the recorded task range could not be inspected safely. */
    error?: string;
    /** The agent's own commits, excluding any carried parent work. */
    log: string;
    stat: string;
    diff: string;
    truncated: boolean;
    /** True when patch bodies were deliberately omitted. */
    summaryOnly?: boolean;
    /** Exact repository-relative path selectors active for this view. */
    pathSelectors?: string[];
    /** Caller-selected character budget, when supplied. */
    patchBudget?: number;
    /** Size before the patch-body budget was applied. */
    patchChars?: number;
    /** Patch-body characters omitted by the budget. */
    omittedPatchChars?: number;
    patchTruncated?: boolean;
    pathSummary?: BranchReviewPathSummary;
  }

  interface BranchReviewOptions {
    mode?: BranchReviewMode;
    /** Convenience form for callers that expose the tool's boolean selector. */
    incremental?: boolean;
    /** Return provenance/stat/path evidence without patch bodies. */
    summaryOnly?: boolean;
    /** Exact repository-relative path selectors. */
    paths?: string[];
    /** Maximum patch-body characters; the default remains 60,000. */
    patchBudget?: number;
  }

  function reviewMode(
    options?: BranchReviewMode | BranchReviewOptions,
  ): BranchReviewMode {
    if (options === 'incremental') return 'incremental';
    if (options && typeof options === 'object') {
      if (options.incremental) return 'incremental';
      if (options.mode) return options.mode;
    }
    return 'full';
  }

  interface ResolvedReviewOptions {
    mode: BranchReviewMode;
    summaryOnly: boolean;
    paths: string[];
    patchBudget?: number;
    active: boolean;
  }

  function safePathSelector(selector: string): boolean {
    const hasControl = [...selector].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
    return (
      selector.length > 0 &&
      selector.length <= MAX_REVIEW_SELECTOR_CHARS &&
      !selector.startsWith('/') &&
      !/^[A-Za-z]:/.test(selector) &&
      !hasControl &&
      !selector.split(/[\\/]/).some((part) => part === '..')
    );
  }

  function resolveReviewOptions(
    options?: BranchReviewMode | BranchReviewOptions,
  ): ResolvedReviewOptions {
    const mode = reviewMode(options);
    if (typeof options === 'string')
      return { mode, summaryOnly: false, paths: [], active: false };
    const summaryOnly = options?.summaryOnly === true;
    const paths = options?.paths ?? [];
    const patchBudget = options?.patchBudget;
    if (!Array.isArray(paths))
      throw new Error(
        'Review paths must be an array of repository-relative paths.',
      );
    if (options?.paths !== undefined && paths.length === 0)
      throw new Error('Review paths must include at least one path selector.');
    if (paths.length > 64)
      throw new Error('Review path selectors are limited to 64 entries.');
    if (
      paths.reduce(
        (total, selector) =>
          total + (typeof selector === 'string' ? selector.length : 0),
        0,
      ) > MAX_REVIEW_SELECTOR_TOTAL_CHARS
    )
      throw new Error(
        `Review path selectors are limited to ${MAX_REVIEW_SELECTOR_TOTAL_CHARS} characters in total.`,
      );
    if (
      paths.some(
        (selector) =>
          typeof selector !== 'string' || !safePathSelector(selector),
      )
    )
      throw new Error(
        'Review paths must be safe repository-relative paths without control characters or .. components.',
      );
    if (
      patchBudget !== undefined &&
      (!Number.isInteger(patchBudget) ||
        patchBudget < 1 ||
        patchBudget > MAX_REVIEW_PATCH_BUDGET)
    )
      throw new Error(
        `patchBudget must be an integer from 1 to ${MAX_REVIEW_PATCH_BUDGET}.`,
      );
    if (summaryOnly && patchBudget !== undefined)
      throw new Error('patchBudget cannot be combined with summaryOnly.');
    return {
      mode,
      summaryOnly,
      paths,
      patchBudget,
      active: summaryOnly || paths.length > 0 || patchBudget !== undefined,
    };
  }

  function pathspecArgs(selectors: string[]): string[] {
    // Literal pathspecs prevent Git pathspec magic from changing the requested
    // repository-relative path, while execFile keeps shell metacharacters data.
    return selectors.map((selector) => `:(top,literal)${selector}`);
  }

  interface UnintegratedTaskPatch {
    commit: string;
    log: string;
    stat: string;
    diff: string;
  }

  /**
   * Compare task commits by patch identity rather than commit identity. This is
   * what makes a carried-WIP branch continue to review correctly after its task
   * commits were cherry-picked into the parent with new hashes.
   */
  async function unintegratedTaskCommits(
    root: string,
    record: WorktreeRecord,
  ): Promise<string[]> {
    const output = await gitText(root, [
      'cherry',
      'HEAD',
      record.branch,
      workBase(record),
    ]);
    const unintegrated = new Set(
      output
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts[0] === '+' && Boolean(parts[1]))
        .map((parts) => parts[1]),
    );
    if (unintegrated.size === 0) return [];

    // `git cherry` reports patch identity, but its output order is an
    // implementation detail of the log walk. Feed integration (and review)
    // commits in the branch's original oldest-to-newest order instead.
    const originalOrder = (
      await gitText(root, [
        'rev-list',
        '--reverse',
        `${workBase(record)}..${record.branch}`,
      ])
    )
      .split('\n')
      .filter(Boolean);
    return originalOrder.filter((commit) => unintegrated.has(commit));
  }

  async function taskPaths(
    root: string,
    commits: string[],
    selectors: string[] = [],
  ): Promise<string[]> {
    const changed = await Promise.all(
      commits.map((commit) =>
        paths(root, [
          'diff',
          '--name-only',
          '-z',
          `${commit}^`,
          commit,
          ...(selectors.length ? ['--', ...pathspecArgs(selectors)] : []),
        ]),
      ),
    );
    return [...new Set(changed.flat())];
  }

  async function taskPatch(
    root: string,
    commit: string,
    selectors: string[] = [],
  ): Promise<UnintegratedTaskPatch> {
    const parent = `${commit}^`;
    const [log, stat, diff] = await Promise.all([
      gitText(root, ['show', '-s', '--format=%h %s', commit]),
      gitText(root, [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--stat',
        parent,
        commit,
        ...(selectors.length ? ['--', ...pathspecArgs(selectors)] : []),
      ]),
      gitText(root, [
        'diff',
        '--no-ext-diff',
        '--no-color',
        parent,
        commit,
        ...(selectors.length ? ['--', ...pathspecArgs(selectors)] : []),
      ]),
    ]);
    return { commit, log, stat, diff };
  }

  function boundedReviewText(
    text: string,
    maxChars: number,
  ): { text: string; truncated: boolean } {
    const truncated = text.length > maxChars;
    return {
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
    };
  }

  function boundedReviewOutput(
    log: string,
    stat: string,
    diff: string,
    patchBudget?: number,
    includePatchMetadata = false,
  ): {
    log: string;
    stat: string;
    diff: string;
    truncated: boolean;
    patchChars?: number;
    omittedPatchChars?: number;
    patchTruncated?: boolean;
  } {
    const boundedLog = boundedReviewText(log, MAX_REVIEW_LOG_CHARS);
    const boundedStat = boundedReviewText(stat, MAX_REVIEW_STAT_CHARS);
    const boundedDiff = boundedReviewText(
      diff,
      patchBudget ?? MAX_REVIEW_DIFF_CHARS,
    );
    const output = {
      log: boundedLog.text,
      stat: boundedStat.text,
      diff: boundedDiff.text,
      truncated:
        boundedLog.truncated || boundedStat.truncated || boundedDiff.truncated,
    };
    return includePatchMetadata
      ? {
          ...output,
          patchChars: diff.length,
          omittedPatchChars: Math.max(0, diff.length - boundedDiff.text.length),
          patchTruncated: boundedDiff.truncated,
        }
      : output;
  }

  function pathSummary(
    allPaths: string[],
    matchedPaths: string[],
  ): BranchReviewPathSummary {
    const all = [...new Set(allPaths)];
    const matched = [...new Set(matchedPaths)];
    const matchedSet = new Set(matched);
    const omitted = all.filter((candidate) => !matchedSet.has(candidate));
    return {
      total: all.length,
      matched: matched.length,
      omitted: omitted.length,
      matchedPaths: matched.slice(0, MAX_REVIEW_PATHS),
      omittedPaths: omitted.slice(0, MAX_REVIEW_PATHS),
    };
  }

  function reviewMetadata(
    resolved: ResolvedReviewOptions,
    summary: BranchReviewPathSummary,
  ): Pick<
    BranchReview,
    'summaryOnly' | 'pathSelectors' | 'patchBudget' | 'pathSummary'
  > {
    return {
      summaryOnly: resolved.summaryOnly,
      ...(resolved.paths.length ? { pathSelectors: resolved.paths } : {}),
      ...(resolved.patchBudget !== undefined
        ? { patchBudget: resolved.patchBudget }
        : {}),
      pathSummary: summary,
    };
  }

  /**
   * Everything needed to judge the work in one call: the agent's commits, what
   * they touched, and the diff — measured from the carry commit, so the parent is
   * never shown its own uncommitted changes as if the agent had written them.
   *
   * The optional incremental view keeps that recorded-range validation, then
   * compares each task commit to the current parent HEAD by patch identity. It
   * renders only the still-unrepresented task patches, so advancing or dirty
   * parent work cannot be attributed to the delegate.
   */
  async function reviewBranch(
    record: WorktreeRecord,
    options?: BranchReviewMode | BranchReviewOptions,
  ): Promise<BranchReview> {
    const resolved = resolveReviewOptions(options);
    const { mode } = resolved;
    const root = record.repositoryRoot;
    const metadata = (getSummary: () => BranchReviewPathSummary) =>
      resolved.active ? reviewMetadata(resolved, getSummary()) : {};
    const state = await branchState(record);
    if (state === 'gone')
      return {
        state,
        mode,
        log: '',
        stat: '',
        diff: '',
        truncated: false,
        ...metadata(() => pathSummary([], [])),
      };
    const range = await workRangeFor(root, record);
    if (!range.valid)
      return {
        state,
        mode,
        error: range.error,
        log: '',
        stat: '',
        diff: '',
        truncated: false,
        ...metadata(() => pathSummary([], [])),
      };

    if (mode === 'incremental') {
      const commits = await unintegratedTaskCommits(root, record);
      if (commits.length === 0)
        return {
          state,
          mode,
          log: '',
          stat: '',
          diff: '',
          truncated: false,
          ...metadata(() => pathSummary([], [])),
        };
      const patches = await Promise.all(
        commits.map((commit) => taskPatch(root, commit, resolved.paths)),
      );
      if (!resolved.active)
        return {
          state,
          mode,
          ...boundedReviewOutput(
            patches.map((patch) => patch.log).join('\n'),
            patches.map((patch) => patch.stat).join('\n'),
            patches.map((patch) => patch.diff).join('\n'),
          ),
        };
      const allPaths = await taskPaths(root, commits);
      const matchedPaths = resolved.paths.length
        ? await taskPaths(root, commits, resolved.paths)
        : allPaths;
      const output = boundedReviewOutput(
        patches.map((patch) => patch.log).join('\n'),
        patches.map((patch) => patch.stat).join('\n'),
        resolved.summaryOnly
          ? ''
          : patches.map((patch) => patch.diff).join('\n'),
        resolved.patchBudget,
        true,
      );
      return {
        state,
        mode,
        ...output,
        ...metadata(() => pathSummary(allPaths, matchedPaths)),
      };
    }

    if (!resolved.active) {
      const [log, stat, full] = await Promise.all([
        gitText(root, ['log', '--oneline', '--no-decorate', range.range]),
        gitText(root, ['diff', '--stat', range.range]),
        gitText(root, ['diff', '--no-ext-diff', '--no-color', range.range]),
      ]);
      return {
        state,
        mode,
        ...boundedReviewOutput(log, stat, full),
      };
    }

    const pathArgs = resolved.paths.length
      ? ['--', ...pathspecArgs(resolved.paths)]
      : [];
    const allPaths = await paths(root, [
      'diff',
      '--name-only',
      '-z',
      range.range,
    ]);
    const matchedPaths = resolved.paths.length
      ? await paths(root, [
          'diff',
          '--name-only',
          '-z',
          range.range,
          ...pathArgs,
        ])
      : allPaths;
    const [log, stat, full] = await Promise.all([
      // Commit provenance remains a complete task history even when the patch
      // view has no matching paths.
      gitText(root, ['log', '--oneline', '--no-decorate', range.range]),
      gitText(root, ['diff', '--stat', range.range, ...pathArgs]),
      resolved.summaryOnly
        ? Promise.resolve('')
        : gitText(root, [
            'diff',
            '--no-ext-diff',
            '--no-color',
            range.range,
            ...pathArgs,
          ]),
    ]);
    return {
      state,
      mode,
      ...boundedReviewOutput(log, stat, full, resolved.patchBudget, true),
      ...metadata(() => pathSummary(allPaths, matchedPaths)),
    };
  }

  interface MergeOutcome {
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
   * deliberately. A carried branch cherry-picks only unintegrated task patches
   * from `workBase..branch`; a normal branch keeps the ordinary no-fast-forward
   * merge.
   */
  async function mergeBranch(record: WorktreeRecord): Promise<MergeOutcome> {
    const root = record.repositoryRoot;
    const state = await branchState(record);
    if (state === 'gone')
      return {
        merged: false,
        reason: `Branch ${record.branch} no longer exists.`,
      };

    const range = await workRangeFor(root, record);
    if (!range.valid)
      return {
        merged: false,
        reason: range.error,
      };
    if (range.carried && !(await hasTaskCommits(root, range.range)))
      return {
        merged: false,
        reason: `${record.branch} has no task commits to merge beyond ${workBase(record).slice(0, 12)}.`,
      };
    if (state === 'merged')
      return {
        merged: false,
        reason: range.carried
          ? `${record.branch}'s task commits are already applied to HEAD; there is nothing to merge.`
          : `${record.branch} is already an ancestor of HEAD; there is nothing to merge.`,
      };

    // A carried branch may have already had some of its task patches applied to
    // HEAD (with different commit IDs). Only the remaining patch-identities are
    // safe to cherry-pick; replaying the whole range would stop on an empty
    // pick before reaching a continuation.
    const taskCommits = range.carried
      ? await unintegratedTaskCommits(root, record)
      : [];
    if (range.carried && taskCommits.length === 0)
      return {
        merged: false,
        reason: `${record.branch}'s task commits are already applied to HEAD; there is nothing to merge.`,
      };
    if (
      await succeeds(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
    )
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

    const [dirty, incoming] = await Promise.all([
      dirtyPaths(root),
      range.carried
        ? taskPaths(root, taskCommits)
        : paths(root, ['diff', '--name-only', '-z', range.range]),
    ]);
    const blockedPaths = incoming.filter((file) => dirty.includes(file));
    if (blockedPaths.length > 0)
      return {
        merged: false,
        blockedPaths,
        reason: `These paths are uncommitted here and also changed by the task on ${record.branch}: commit or stash them first.`,
      };

    const cherryPick = range.carried;
    try {
      await git(
        root,
        cherryPick
          ? ['cherry-pick', '--no-edit', ...taskCommits]
          : ['merge', '--no-ff', '--no-edit', record.branch],
      );
      return {
        merged: true,
        commit: await gitText(root, ['rev-parse', 'HEAD']),
      };
    } catch (error) {
      const conflicted = await paths(root, [
        'diff',
        '--name-only',
        '--diff-filter=U',
        '-z',
      ]).catch(() => []);
      const abortCommand = cherryPick
        ? ['cherry-pick', '--abort']
        : ['merge', '--abort'];
      let abortFailed = false;
      let abortError: unknown;
      try {
        await git(root, abortCommand);
      } catch (cleanupError) {
        abortFailed = true;
        abortError = cleanupError;
      }

      const command = cherryPick
        ? `git cherry-pick ${taskCommits.join(' ')}`
        : `git merge ${record.branch}`;
      if (abortFailed) {
        const operation = cherryPick ? 'cherry-pick' : 'merge';
        const abort = cherryPick
          ? 'git cherry-pick --abort'
          : 'git merge --abort';
        const continueCommand = cherryPick
          ? 'git cherry-pick --continue'
          : 'git merge --continue';
        return {
          merged: false,
          conflicted,
          reason: `Integration ${conflicted.length ? 'conflicted' : 'failed'}, and cleanup failed: ${abortError instanceof Error ? abortError.message : String(abortError)}. Your checkout may still be mid-${operation}; inspect it with: git status. Then run ${abort}, or resolve and run ${continueCommand}.`,
        };
      }
      return {
        merged: false,
        conflicted,
        reason: conflicted.length
          ? `Integration conflicted and was aborted; your checkout is unchanged. Resolve deliberately with: ${command}`
          : `Integration failed and was aborted; your checkout is unchanged: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { branchState, reviewBranch, mergeBranch };
}

const defaultIntegrator = createWorktreeIntegrator();
export const branchState = defaultIntegrator.branchState;
export const reviewBranch = defaultIntegrator.reviewBranch;
export const mergeBranch = defaultIntegrator.mergeBranch;
