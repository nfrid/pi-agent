import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  canonical,
  git,
  gitText,
  isInside,
  repositoryRoot,
  splitZ,
} from './git';
import type {
  PreparedWorktree,
  WorktreeBase,
  WorktreePreparation,
  WorktreeRecord,
} from './model';
import { writeWorktreeRecord } from './records';

/** Worktrees live beside the repository so `git worktree list` reads naturally. */
const WORKTREE_DIR = '.worktrees';
const BRANCH_PREFIX = 'pi';
const MAX_SETUP_ERROR_CHARS = 2_000;

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
    'Carried uncommitted parent work\n\nApplied by pi delegate so the task starts where the parent actually is.',
  ]);
  return await gitText(worktreePath, ['rev-parse', 'HEAD']);
}

export async function prepareWorktree(options: {
  cwd: string;
  name: string;
  base?: WorktreeBase;
  /** Parent Pi session creating this fresh or refreshed record. */
  parentSessionId?: string;
}): Promise<WorktreePreparation> {
  let root: string;
  try {
    root = await repositoryRoot(options.cwd);
  } catch (error) {
    return {
      fallbackReason: `Worktree unavailable: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  const id = randomUUID();
  const base = options.base ?? 'wip';
  const canonicalCwd = canonical(options.cwd);
  const workingDirectory = path.relative(root, canonicalCwd);
  let worktreePath: string | undefined;
  let branch: string | undefined;

  try {
    const baseHead = await gitText(root, ['rev-parse', 'HEAD']);
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
    await git(root, ['worktree', 'add', '-b', branch, worktreePath, baseHead]);

    const carryCommit =
      base === 'wip'
        ? await carryWorkInProgress(root, worktreePath)
        : undefined;
    const now = new Date().toISOString();
    const record: WorktreeRecord = {
      version: 1,
      id,
      creatorSessionId: options.parentSessionId,
      repositoryRoot: root,
      worktreePath,
      workingDirectory,
      branch,
      baseHead,
      base,
      carriedWip: Boolean(carryCommit),
      ...(carryCommit ? { carryCommit } : {}),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    writeWorktreeRecord(record);
    return { worktree: { record, env: { PI_DELEGATE_WORKTREE: id } } };
  } catch (error) {
    await cleanupFailedPreparation(root, worktreePath, branch);
    return { fallbackReason: setupFailure(error) };
  }
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

export function attachWorktreeSession(
  worktree: PreparedWorktree,
  token: string,
): PreparedWorktree {
  const record = { ...worktree.record, sessionToken: token };
  writeWorktreeRecord(record);
  return { record, env: worktree.env };
}

export function restoreWorktreeSession(
  record: WorktreeRecord,
  token: string,
): PreparedWorktree {
  if (!existsSync(record.worktreePath))
    throw new Error('The worktree for this continuation is unavailable.');
  if (record.sessionToken && record.sessionToken !== token)
    throw new Error('This worktree belongs to another delegate session.');
  if (record.status === 'removed')
    throw new Error('This worktree has already been removed.');
  return { record, env: { PI_DELEGATE_WORKTREE: record.id } };
}

export async function rehydrateWorktreeSession(
  record: WorktreeRecord,
  token: string,
): Promise<PreparedWorktree> {
  if (existsSync(record.worktreePath))
    return restoreWorktreeSession(record, token);
  if (record.sessionToken && record.sessionToken !== token)
    throw new Error('This worktree belongs to another delegate session.');
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
    record.status = 'active';
    delete record.snapshot;
    writeWorktreeRecord(record);
    return { record, env: { PI_DELEGATE_WORKTREE: record.id } };
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

export { isInside, WORKTREE_DIR };
