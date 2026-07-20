import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { MANIFEST_NAMES } from './constants';
import { canonical, delegateChildEnvironment, git, isInside } from './kernel';
import { processIdentity, withIsolationLock } from './locks';
import type {
  DependencyMode,
  EffectiveDependencyMode,
  IsolationPreparation,
  IsolationRecord,
  PreparedIsolation,
} from './model';
import {
  isolationRecordDir,
  loadIsolation,
  writeIsolationRecord,
} from './records';
import { sandboxBackendAvailable, sandboxProfile } from './sandbox';

async function repositoryRoot(cwd: string): Promise<string> {
  const raw = String(await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const root = canonical(raw);
  if (!isInside(root, canonical(cwd)))
    throw new Error('cwd is outside repository root');
  return root;
}

async function manifestSnapshot(repositoryRoot: string): Promise<{
  hash: string;
  packageDirs: string[];
}> {
  const output = String(
    await git(repositoryRoot, [
      'ls-files',
      '-z',
      '--',
      '**/package.json',
      'package.json',
      '*lock*',
    ]),
  );
  const files = output
    .split('\0')
    .filter(Boolean)
    .filter((file) => MANIFEST_NAMES.has(path.basename(file)))
    .sort();
  const hash = createHash('sha256');
  const packageDirs = new Set<string>();
  for (const file of files) {
    const absolute = path.join(repositoryRoot, file);
    if (!existsSync(absolute)) continue;
    hash.update(file).update('\0').update(readFileSync(absolute)).update('\0');
    if (path.basename(file) === 'package.json')
      packageDirs.add(path.dirname(file));
  }
  return { hash: hash.digest('hex'), packageDirs: [...packageDirs].sort() };
}

function scopePaths(
  repositoryRoot: string,
  cwd: string,
  scopes: string[],
): Array<{
  relative: string;
  directory: boolean;
}> {
  if (scopes.length === 0)
    throw new Error('writable delegation requires scope directories');
  return scopes.map((scope) => {
    const absolute = canonical(path.resolve(cwd, scope));
    if (!isInside(repositoryRoot, absolute))
      throw new Error(`scope escapes repository: ${scope}`);
    return {
      relative: path.relative(repositoryRoot, absolute),
      directory: lstatSync(absolute).isDirectory(),
    };
  });
}

function linkDependencies(
  repositoryRoot: string,
  worktreePath: string,
  packageDirs: string[],
): string[] {
  const links: string[] = [];
  for (const directory of packageDirs.slice(0, 100)) {
    const source = path.join(repositoryRoot, directory, 'node_modules');
    const target = path.join(worktreePath, directory, 'node_modules');
    if (!existsSync(source) || existsSync(target)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(source, target, 'dir');
    links.push(path.relative(worktreePath, target));
  }
  return links;
}

export async function prepareWritableIsolation(options: {
  cwd: string;
  scopes: string[];
  dependencyMode?: DependencyMode;
}): Promise<IsolationPreparation> {
  if (!sandboxBackendAvailable())
    return {
      fallbackReason:
        'No supported OS/container sandbox backend is available; running read-only.',
    };
  let repositoryRootValue: string;
  try {
    repositoryRootValue = await repositoryRoot(options.cwd);
    const status = String(
      await git(repositoryRootValue, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]),
    );
    if (status.trim())
      return {
        fallbackReason:
          'Parent repository is dirty; isolated writes require a clean, exact base and were downgraded to read-only.',
      };
  } catch (error) {
    return {
      fallbackReason: `Writable isolation unavailable: ${error instanceof Error ? error.message : String(error)}. Running read-only.`,
    };
  }

  const id = randomUUID();
  const directory = isolationRecordDir(id);
  const worktreePath = path.join(directory, 'worktree');
  const scratchPath = path.join(directory, 'scratch');
  mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
  let worktreeAdded = false;
  try {
    const canonicalCwd = canonical(options.cwd);
    const scopes = scopePaths(
      repositoryRootValue,
      canonicalCwd,
      options.scopes,
    );
    const workingDirectory = path.relative(repositoryRootValue, canonicalCwd);
    const baseHead = String(
      await git(repositoryRootValue, ['rev-parse', 'HEAD']),
    ).trim();
    await git(repositoryRootValue, [
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '--detach',
      '--lock',
      '--reason',
      `pi delegate ${id}`,
      worktreePath,
      baseHead,
    ]);
    worktreeAdded = true;
    const snapshot = await manifestSnapshot(repositoryRootValue);
    const requestedDependencyMode = options.dependencyMode ?? 'auto';
    const dependencyLinks =
      requestedDependencyMode === 'isolated'
        ? []
        : linkDependencies(
            repositoryRootValue,
            worktreePath,
            snapshot.packageDirs,
          );
    const dependencyMode: EffectiveDependencyMode =
      requestedDependencyMode === 'isolated' || dependencyLinks.length === 0
        ? 'isolated'
        : 'link';
    const writablePaths = scopes.map(({ relative }) =>
      path.join(worktreePath, relative),
    );
    const now = new Date().toISOString();
    const record: IsolationRecord = {
      version: 1,
      id,
      repositoryRoot: repositoryRootValue,
      worktreePath,
      workingDirectory,
      scratchPath,
      baseHead,
      requestedScopes: scopes.map(({ relative }) => relative || '.'),
      writablePaths,
      requestedDependencyMode,
      dependencyMode,
      dependencyLinks,
      manifestHash: snapshot.hash,
      backend: 'macos-sandbox-exec',
      createdAt: now,
      updatedAt: now,
      status: 'prepared',
    };
    writeIsolationRecord(record);
    return {
      isolation: {
        record,
        profilePath: path.join(scratchPath, 'sandbox.sb'),
        env: {},
      },
    };
  } catch (error) {
    let cleanupError: string | undefined;
    if (worktreeAdded) {
      try {
        await git(repositoryRootValue, ['worktree', 'unlock', worktreePath]);
      } catch {
        // An unlocked worktree is also removable.
      }
      try {
        await git(repositoryRootValue, [
          'worktree',
          'remove',
          '--force',
          worktreePath,
        ]);
      } catch (cleanup) {
        cleanupError =
          cleanup instanceof Error ? cleanup.message : String(cleanup);
      }
    }
    if (cleanupError) {
      writeFileSync(
        path.join(directory, 'recovery.json'),
        `${JSON.stringify({ version: 1, id, repositoryRoot: repositoryRootValue, worktreePath, scratchPath, status: 'failed', error: error instanceof Error ? error.message : String(error), cleanupError }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } else {
      rmSync(directory, { recursive: true, force: true });
    }
    return {
      fallbackReason: `Writable isolation setup failed: ${error instanceof Error ? error.message : String(error)}.${cleanupError ? ` Recovery ${id} was retained because cleanup failed.` : ''} Running read-only.`,
    };
  }
}

export function attachIsolationSession(
  isolation: PreparedIsolation,
  token: string,
  sessionPath: string,
): PreparedIsolation {
  const record = { ...isolation.record, sessionToken: token };
  const profile = sandboxProfile(record, sessionPath);
  writeFileSync(isolation.profilePath, profile, {
    encoding: 'utf8',
    mode: 0o600,
  });
  writeIsolationRecord(record);
  return {
    record,
    profilePath: isolation.profilePath,
    env: delegateChildEnvironment(record.scratchPath),
  };
}

export function restoreIsolationSession(
  record: IsolationRecord,
  token: string,
  sessionPath: string,
): PreparedIsolation {
  if (!existsSync(record.worktreePath) || !existsSync(record.scratchPath))
    throw new Error('Isolated worktree is unavailable');
  if (record.sessionToken && record.sessionToken !== token)
    throw new Error('Isolation belongs to another delegate session');
  if (
    record.status === 'applied' ||
    record.status === 'discarded' ||
    record.status === 'conflicted'
  )
    throw new Error(`Isolation is already ${record.status}`);
  return attachIsolationSession(
    {
      record,
      profilePath: path.join(record.scratchPath, 'sandbox.sb'),
      env: {},
    },
    token,
    sessionPath,
  );
}

export async function markIsolationRunning(
  id: string,
): Promise<IsolationRecord> {
  return withIsolationLock(id, async () => {
    const record = loadIsolation(id);
    if (!record) throw new Error('Isolation record not found');
    if (
      record.status === 'applied' ||
      record.status === 'discarded' ||
      record.status === 'conflicted'
    )
      throw new Error(`Isolation is already ${record.status}`);
    if (
      record.status === 'running' &&
      record.runOwner &&
      processIdentity(record.runOwner.pid) === record.runOwner.identity
    )
      throw new Error('Isolation already has an active delegate run');
    const identity = processIdentity(process.pid);
    if (!identity)
      throw new Error('Cannot establish delegate run owner identity');
    record.status = 'running';
    record.runOwner = {
      pid: process.pid,
      identity,
      startedAt: new Date().toISOString(),
    };
    record.validation = {
      status: 'not-run',
      reason: 'Delegate run is active; recapture and validation are required.',
    };
    writeIsolationRecord(record);
    return record;
  });
}

export async function failIsolationRun(
  id: string,
  error: unknown,
): Promise<IsolationRecord> {
  return withIsolationLock(id, async () => {
    const record = loadIsolation(id);
    if (!record) throw new Error('Isolation record not found');
    if (record.status === 'running') {
      record.status = 'failed';
      record.runOwner = undefined;
      record.runOutcome = 'error';
      record.error = `Delegate finalization failed: ${error instanceof Error ? error.message : String(error)}`;
      writeIsolationRecord(record);
    }
    return record;
  });
}
