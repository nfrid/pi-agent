import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
const MAX_LINKED_PACKAGE_DIRS = 100;

/**
 * Gitignored files a fresh checkout needs but git will never provide. Copying
 * these is most of what makes a worktree usable without per-repo setup hooks.
 */
const CARRIED_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
];

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

/** Symlink each package directory's node_modules from the parent checkout. */
function linkDependencies(
  repositoryRoot: string,
  worktreePath: string,
  packageDirs: string[],
): string[] {
  const links: string[] = [];
  for (const directory of packageDirs.slice(0, MAX_LINKED_PACKAGE_DIRS)) {
    const source = path.join(repositoryRoot, directory, 'node_modules');
    const target = path.join(worktreePath, directory, 'node_modules');
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(source, target, 'dir');
      links.push(path.relative(worktreePath, target));
    } catch {
      // A worktree without linked dependencies still runs; it just needs an
      // install. Never fail preparation over one link.
    }
  }
  return links;
}

async function packageDirectories(worktreePath: string): Promise<string[]> {
  const files = splitZ(
    String(
      await git(worktreePath, [
        'ls-files',
        '-z',
        '--',
        'package.json',
        '**/package.json',
      ]),
    ),
  );
  return [...new Set(files.map((file) => path.dirname(file)))].sort();
}

/** Copy gitignored-but-required files (.env and friends) into the worktree. */
function carryFiles(repositoryRoot: string, worktreePath: string): string[] {
  const carried: string[] = [];
  for (const name of CARRIED_FILES) {
    const source = path.join(repositoryRoot, name);
    const target = path.join(worktreePath, name);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      copyFileSync(source, target);
      carried.push(name);
    } catch {
      // Best effort, same reasoning as dependency links.
    }
  }
  return carried;
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
 * Called before dependencies are linked and gitignored files are copied in, so
 * nothing injected can ride along on this commit.
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
    // core.hooksPath=/dev/null: a repo's own checkout hooks must not run for a
    // worktree we create on the user's behalf.
    await git(root, [
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      baseHead,
    ]);

    const carryCommit =
      base === 'wip'
        ? await carryWorkInProgress(root, worktreePath)
        : undefined;
    const dependencyLinks = linkDependencies(
      root,
      worktreePath,
      await packageDirectories(worktreePath),
    );
    const carried = carryFiles(root, worktreePath);

    const now = new Date().toISOString();
    const record: WorktreeRecord = {
      version: 1,
      id,
      repositoryRoot: root,
      worktreePath,
      workingDirectory,
      branch,
      baseHead,
      base,
      carriedWip: Boolean(carryCommit),
      ...(carryCommit ? { carryCommit } : {}),
      dependencyLinks,
      carriedFiles: carried,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    writeWorktreeRecord(record);
    return { worktree: { record, env: { PI_DELEGATE_WORKTREE: id } } };
  } catch (error) {
    await cleanupFailedPreparation(root, worktreePath, branch);
    return {
      fallbackReason: `Worktree setup failed: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

async function cleanupFailedPreparation(
  repositoryRoot: string,
  worktreePath: string | undefined,
  branch: string | undefined,
): Promise<void> {
  if (worktreePath && existsSync(worktreePath)) {
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

export { isInside, WORKTREE_DIR };
