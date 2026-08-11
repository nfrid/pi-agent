import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  canonical,
  git,
  gitText,
  repositoryIdentity,
  repositoryRoot,
  splitZ,
} from './git.js';
import type {
  PreparedWorktree,
  WorktreeBase,
  WorktreePreparation,
  WorktreeRecord,
} from './model.js';
import type { WorktreeStore } from './store.js';

/** Worktrees live beside the repository so `git worktree list` reads naturally. */
export const WORKTREE_DIR = '.worktrees';
const BRANCH_PREFIX = 'pi';
const MAX_SETUP_ERROR_CHARS = 2_000;
const DEFAULT_WORKTREE_ENVIRONMENT_VARIABLE = 'PI_WORKTREE_ID';
const DEFAULT_CARRY_COMMIT_MESSAGE =
  'Carried uncommitted parent work\n\nApplied by pi worktree manager so the task starts from the parent working state.';
const MAX_BASE_REF_CHARS = 512;
const SAFE_BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'task';
}

/**
 * Keep `.worktrees/` out of git's way without touching the user's tracked
 * .gitignore — info/exclude is local-only, which is the seamless choice.
 */
function excludeWorktreeDir(repositoryRoot: string): void {
  try {
    const excludePath = path.join(repositoryRoot, '.git', 'info', 'exclude');
    if (!existsSync(path.dirname(excludePath))) return;
    const entry = `/${WORKTREE_DIR}/`;
    const current = existsSync(excludePath)
      ? readFileSync(excludePath, 'utf8')
      : '';
    if (current.split('\n').some((line) => line.trim() === entry)) return;
    appendFileSync(
      excludePath,
      `${current.endsWith('\n') || !current ? '' : '\n'}${entry}\n`,
    );
  } catch {
    // A missing or read-only .git/info is not worth failing preparation over;
    // the worktree still works, it just shows up as untracked.
  }
}

async function uniqueBranch(
  repositoryRoot: string,
  base: string,
): Promise<string> {
  const existing = new Set(
    splitZ(
      String(
        await git(repositoryRoot, [
          'for-each-ref',
          '--format=%(refname:short)%00',
          'refs/heads',
        ]),
      ),
    ),
  );
  const candidate = `${BRANCH_PREFIX}/${base}`;
  if (!existing.has(candidate)) return candidate;
  for (let suffix = 2; ; suffix++) {
    const next = `${candidate}-${suffix}`;
    if (!existing.has(next)) return next;
  }
}

/**
 * Reproduce the parent's uncommitted work inside the worktree: the tracked diff
 * plus any untracked files git is not ignoring. This is what lets a delegate
 * continue from where you actually are rather than from your last commit.
 *
 * The carry becomes its own commit. Two things depend on that: the agent starts
 * on a clean tree, so its own commits describe only its own work, and the
 * parent can review `carryCommit..branch` without its own uncommitted changes
 * mixed into the diff it is judging.
 *
 * Native checkout hooks run before this carry step. Hook-created ignored setup
 * stays local to the child and, like the parent's ignored files, cannot ride
 * along on this commit.
 */
async function carryWorkInProgress(
  repositoryRoot: string,
  worktreePath: string,
  commitMessage: string,
): Promise<string | undefined> {
  let carried = false;

  const diff = (await git(repositoryRoot, ['diff', 'HEAD', '--binary'], {
    encoding: 'buffer',
  })) as Buffer;
  if (diff.length > 0) {
    await git(worktreePath, ['apply', '--whitespace=nowarn', '-'], {
      input: diff,
    });
    carried = true;
  }

  const untracked = splitZ(
    String(
      await git(repositoryRoot, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ]),
    ),
  );
  for (const relative of untracked) {
    const source = path.join(repositoryRoot, relative);
    const target = path.join(worktreePath, relative);
    if (!existsSync(source) || existsSync(target)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    carried = true;
  }

  if (!carried) return undefined;
  await git(worktreePath, ['add', '--all']);
  await git(worktreePath, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--no-verify',
    '--message',
    commitMessage,
  ]);
  return await gitText(worktreePath, ['rev-parse', 'HEAD']);
}

interface RegisteredWorktree {
  path: string;
  branch?: string;
}

async function registeredWorktrees(
  repositoryRootPath: string,
): Promise<RegisteredWorktree[]> {
  const lines = String(
    await git(repositoryRootPath, ['worktree', 'list', '--porcelain']),
  ).split(/\r?\n/);
  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      entries.push(current);
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  return entries;
}

export interface ExistingWorktreeValidation {
  worktreePath: string;
  repositoryRoot: string;
  branch: string;
  headCommit: string;
}

/**
 * Validate a caller-selected checkout without changing it. Git's common
 * directory proves repository identity across linked worktrees; the porcelain
 * inventory proves that the path is an actual registered worktree rather than
 * an arbitrary directory containing a .git file.
 */
export async function validateExistingWorktree(options: {
  cwd: string;
  worktreePath: string;
  expectedRepositoryRoot?: string;
  expectedBranch?: string;
  expectedHead?: string;
  /** Continuations may validate the already-selected checkout as cwd. */
  allowRequestedCheckout?: boolean;
}): Promise<ExistingWorktreeValidation> {
  if (!path.isAbsolute(options.worktreePath))
    throw new Error('the caller worktree path must be absolute');
  if (!existsSync(options.worktreePath))
    throw new Error('the caller worktree path does not exist');
  if (!statSync(options.worktreePath).isDirectory())
    throw new Error('the caller worktree path is not a directory');

  const requestedRoot = await repositoryRoot(options.cwd);
  const targetPath = canonical(options.worktreePath);
  const targetRoot = await repositoryRoot(targetPath);
  if (targetRoot !== targetPath)
    throw new Error('the caller path must be the worktree root');
  if (targetPath === requestedRoot && !options.allowRequestedCheckout)
    throw new Error('the caller worktree must not be the requested checkout');
  if (
    (await repositoryIdentity(options.cwd)) !==
    (await repositoryIdentity(targetPath))
  )
    throw new Error('the caller worktree belongs to a different repository');
  if (
    options.expectedRepositoryRoot &&
    (await repositoryIdentity(options.expectedRepositoryRoot)) !==
      (await repositoryIdentity(targetPath))
  )
    throw new Error('the recorded worktree repository no longer matches');

  const registered = await registeredWorktrees(requestedRoot);
  const entry = registered.find((candidate) => {
    try {
      return canonical(candidate.path) === targetPath;
    } catch {
      return false;
    }
  });
  if (!entry) throw new Error('the path is not a registered Git worktree');

  let branch: string;
  try {
    branch = await gitText(targetPath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
  } catch {
    throw new Error('the caller worktree must be checked out on a branch');
  }
  if (!entry.branch || entry.branch !== branch)
    throw new Error('the Git worktree branch metadata is inconsistent');
  if (options.expectedBranch && options.expectedBranch !== branch)
    throw new Error('the caller worktree branch changed since delegate setup');

  const status = String(
    await git(targetPath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]),
  );
  if (status.trim())
    throw new Error('the caller worktree must be clean before delegation');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD'] as const) {
    if (
      await (async () => {
        try {
          await git(targetPath, ['rev-parse', '--verify', '--quiet', marker]);
          return true;
        } catch {
          return false;
        }
      })()
    )
      throw new Error(
        `the caller worktree has an in-progress ${marker} operation`,
      );
  }
  const gitDir = await gitText(targetPath, ['rev-parse', '--git-dir']);
  const resolvedGitDir = path.isAbsolute(gitDir)
    ? gitDir
    : path.resolve(targetPath, gitDir);
  if (
    existsSync(path.join(resolvedGitDir, 'rebase-merge')) ||
    existsSync(path.join(resolvedGitDir, 'rebase-apply'))
  )
    throw new Error('the caller worktree has an in-progress rebase');

  const headCommit = await gitText(targetPath, ['rev-parse', 'HEAD']);
  if (options.expectedHead && headCommit !== options.expectedHead)
    throw new Error(
      'the caller worktree changed since the previous delegate run',
    );
  return {
    worktreePath: targetPath,
    repositoryRoot: requestedRoot,
    branch,
    headCommit,
  };
}

export interface WorktreeCreatorOptions {
  /** Environment variable used to identify the prepared checkout. */
  environmentVariable?: string;
  /** Commit message used for the synthetic parent-WIP carry commit. */
  carryCommitMessage?: string;
}

export interface WorktreeCreator<
  Record extends WorktreeRecord = WorktreeRecord,
> {
  prepareWorktree(options: {
    cwd: string;
    name: string;
    base?: WorktreeBase;
    /** Safe branch/ref to resolve instead of the parent's current HEAD. */
    baseRef?: string;
    /** Existing, validated caller-owned worktree to use without creating one. */
    worktreePath?: string;
  }): Promise<WorktreePreparation<Record>>;
  /** Recreate a retired checkout from its retained branch ref. */
  rehydrateWorktree(record: Record): Promise<PreparedWorktree<Record>>;
}

export function createWorktreeCreator<
  Record extends WorktreeRecord = WorktreeRecord,
>(
  store: WorktreeStore<Record>,
  options: WorktreeCreatorOptions = {},
): WorktreeCreator<Record> {
  const environmentVariable =
    options.environmentVariable ?? DEFAULT_WORKTREE_ENVIRONMENT_VARIABLE;
  const carryCommitMessage =
    options.carryCommitMessage ?? DEFAULT_CARRY_COMMIT_MESSAGE;
  const environment = (id: string): NodeJS.ProcessEnv => ({
    [environmentVariable]: id,
  });
  function activateRecord(record: Record): void {
    record.status = 'active';
    delete record.snapshot;
    const previousUpdatedAt = Date.parse(record.updatedAt);
    record.updatedAt = new Date(
      Math.max(
        Date.now(),
        Number.isNaN(previousUpdatedAt) ? 0 : previousUpdatedAt + 1,
      ),
    ).toISOString();
    store.writeWorktreeRecord(record);
  }
  async function prepareWorktree(options: {
    cwd: string;
    name: string;
    base?: WorktreeBase;
    baseRef?: string;
    worktreePath?: string;
  }): Promise<WorktreePreparation<Record>> {
    let root: string;
    try {
      root = await repositoryRoot(options.cwd);
    } catch (error) {
      return {
        fallbackReason: `Worktree unavailable: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    const id = randomUUID();
    const baseRef = options.baseRef;
    if (options.worktreePath) {
      if (options.base !== undefined || options.baseRef !== undefined)
        return {
          fallbackReason:
            'Caller worktree selection cannot be combined with a base/ref; the existing branch is the source snapshot.',
        };
      try {
        const existing = await validateExistingWorktree({
          cwd: options.cwd,
          worktreePath: options.worktreePath,
        });
        const canonicalCwd = canonical(options.cwd);
        const workingDirectory = path.relative(root, canonicalCwd);
        const now = new Date().toISOString();
        const record = {
          version: 1 as const,
          id,
          repositoryRoot: existing.repositoryRoot,
          worktreePath: existing.worktreePath,
          workingDirectory,
          branch: existing.branch,
          ownership: 'caller' as const,
          baseHead: existing.headCommit,
          base: 'head' as const,
          carriedWip: false,
          status: 'active' as const,
          createdAt: now,
          updatedAt: now,
          // The selected checkout is already at this tip. Keeping the initial
          // tip lets read-only runs detect a shell-side commit without ever
          // committing or deleting caller-owned work.
          headCommit: existing.headCommit,
        } as Record;
        store.writeWorktreeRecord(record);
        return { worktree: { record, env: environment(id) } };
      } catch (error) {
        return {
          fallbackReason: `Caller worktree unavailable: ${error instanceof Error ? error.message : String(error)}.`,
        };
      }
    }
    if (
      baseRef !== undefined &&
      (baseRef.length === 0 ||
        baseRef.length > MAX_BASE_REF_CHARS ||
        !SAFE_BASE_REF.test(baseRef) ||
        baseRef.includes('..') ||
        baseRef.includes('@{') ||
        baseRef.endsWith('.') ||
        baseRef.endsWith('/') ||
        baseRef.includes('//'))
    )
      return {
        fallbackReason: 'Worktree unavailable: invalid base branch/ref.',
      };
    const base = baseRef === undefined ? (options.base ?? 'wip') : 'head';
    const canonicalCwd = canonical(options.cwd);
    const workingDirectory = path.relative(root, canonicalCwd);
    let worktreePath: string | undefined;
    let branch: string | undefined;

    try {
      const baseHead = await gitText(
        root,
        baseRef === undefined
          ? ['rev-parse', 'HEAD']
          : [
              'rev-parse',
              '--verify',
              '--end-of-options',
              `${baseRef}^{commit}`,
            ],
      );
      branch = await uniqueBranch(root, slugify(options.name));
      worktreePath = path.join(root, WORKTREE_DIR, path.basename(branch));
      if (existsSync(worktreePath))
        worktreePath = path.join(
          root,
          WORKTREE_DIR,
          `${path.basename(branch)}-${id.slice(0, 8)}`,
        );

      excludeWorktreeDir(root);
      mkdirSync(path.dirname(worktreePath), { recursive: true });
      // Do not override core.hooksPath: `worktree add` must honor the
      // repository's native checkout/setup hooks.
      await git(root, [
        'worktree',
        'add',
        '-b',
        branch,
        worktreePath,
        baseHead,
      ]);

      const carryCommit =
        base === 'wip'
          ? await carryWorkInProgress(root, worktreePath, carryCommitMessage)
          : undefined;
      const now = new Date().toISOString();
      const record = {
        version: 1 as const,
        id,
        repositoryRoot: root,
        worktreePath,
        workingDirectory,
        branch,
        baseHead,
        base,
        ...(baseRef ? { baseRef } : {}),
        carriedWip: Boolean(carryCommit),
        ...(carryCommit ? { carryCommit } : {}),
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      } as Record;
      store.writeWorktreeRecord(record);
      return { worktree: { record, env: environment(id) } };
    } catch (error) {
      await cleanupFailedPreparation(root, worktreePath, branch);
      return { fallbackReason: setupFailure(error) };
    }
  }

  async function rehydrateWorktree(
    record: Record,
  ): Promise<PreparedWorktree<Record>> {
    if (record.ownership === 'caller' && !existsSync(record.worktreePath))
      throw new Error(
        'This caller-owned worktree is unavailable and will not be recreated by the harness.',
      );
    if (existsSync(record.worktreePath)) {
      // A retry may reuse a settled checkout without recreating its directory.
      // Persist the active ownership and a fresh lifecycle timestamp before the
      // caller launches a new agent against it.
      activateRecord(record);
      return { record, env: environment(record.id) };
    }
    if (record.status === 'removed')
      throw new Error('This worktree has already been removed.');
    try {
      mkdirSync(path.dirname(record.worktreePath), { recursive: true });
      // Keep native Git worktree semantics for snapshot rehydration too, so the
      // configured checkout/setup hooks can recreate ignored child-local state.
      await git(record.repositoryRoot, [
        'worktree',
        'add',
        record.worktreePath,
        record.branch,
      ]);
      activateRecord(record);
      return { record, env: environment(record.id) };
    } catch (error) {
      await cleanupFailedPreparation(
        record.repositoryRoot,
        record.worktreePath,
        undefined,
      );
      throw new Error(
        `Could not rehydrate the worktree snapshot: ${setupFailure(error)}`,
      );
    }
  }

  return {
    prepareWorktree,
    rehydrateWorktree,
  };
}

function setupFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const bounded =
    detail.length <= MAX_SETUP_ERROR_CHARS
      ? detail
      : `${detail.slice(0, MAX_SETUP_ERROR_CHARS - 1)}…`;
  return `Worktree setup failed while running the repository checkout/setup hooks. Fix the hook or its project setup command and retry; no delegate was launched. ${bounded}`;
}

async function cleanupFailedPreparation(
  repositoryRoot: string,
  worktreePath: string | undefined,
  branch: string | undefined,
): Promise<void> {
  if (worktreePath) {
    // Ask Git to unregister the checkout even if a failing hook removed its
    // directory before returning; otherwise the branch can remain checked out.
    await git(repositoryRoot, [
      'worktree',
      'remove',
      '--force',
      worktreePath,
    ]).catch(() => undefined);
    rmSync(worktreePath, { recursive: true, force: true });
  }
  if (branch) {
    await git(repositoryRoot, ['branch', '-D', branch]).catch(() => undefined);
  }
}

export { canonical, isInside, repositoryRoot, splitZ } from './git.js';
