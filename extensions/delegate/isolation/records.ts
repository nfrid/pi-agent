import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { IsolationRecord } from './model';

const ROOT = 'delegate-worktrees/v1';
const SAFE_ID = /^[0-9a-f-]{36}$/;

export function delegateStateRoot(): string {
  return (
    process.env.PI_DELEGATE_STATE_DIR ??
    path.join(
      process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state'),
      'pi-agent',
    )
  );
}

export function isolationRootDir(): string {
  return path.join(delegateStateRoot(), ROOT);
}

export function isolationRecordDir(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('Invalid isolation identifier');
  return path.join(isolationRootDir(), id);
}

function recordPath(id: string): string {
  return path.join(isolationRecordDir(id), 'record.json');
}

export function writeIsolationRecord(record: IsolationRecord): void {
  record.updatedAt = new Date().toISOString();
  const target = recordPath(record.id);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, target);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function validWritablePath(worktree: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const resolved = path.resolve(candidate);
  if (!inside(worktree, resolved)) return false;
  if (!existsSync(resolved) || !existsSync(worktree)) return true;
  try {
    return inside(realpathSync(worktree), realpathSync(resolved));
  } catch {
    return false;
  }
}

function validDependencyLink(
  repositoryRoot: string,
  worktree: string,
  candidate: unknown,
): boolean {
  if (
    typeof candidate !== 'string' ||
    !candidate ||
    path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate ||
    candidate.split(path.sep).includes('..') ||
    path.basename(candidate) !== 'node_modules'
  )
    return false;
  const linkPath = path.resolve(worktree, candidate);
  if (!inside(worktree, linkPath)) return false;
  if (!existsSync(linkPath)) return true;
  const expected = path.resolve(repositoryRoot, candidate);
  try {
    return (
      inside(realpathSync(repositoryRoot), realpathSync(expected)) &&
      realpathSync(linkPath) === realpathSync(expected)
    );
  } catch {
    return false;
  }
}

function validRecord(value: unknown, id: string): value is IsolationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as IsolationRecord;
  const directory = path.resolve(isolationRecordDir(id));
  const worktree = path.resolve(directory, 'worktree');
  const scratch = path.resolve(directory, 'scratch');
  const statuses = new Set([
    'prepared',
    'running',
    'ran',
    'patch-ready',
    'no-changes',
    'applied',
    'discarded',
    'conflicted',
    'failed',
  ]);
  return (
    record.version === 1 &&
    record.id === id &&
    SAFE_ID.test(record.id) &&
    typeof record.repositoryRoot === 'string' &&
    path.isAbsolute(record.repositoryRoot) &&
    existsSync(path.join(record.repositoryRoot, '.git')) &&
    path.resolve(record.worktreePath) === worktree &&
    path.resolve(record.scratchPath) === scratch &&
    typeof record.workingDirectory === 'string' &&
    !path.isAbsolute(record.workingDirectory) &&
    inside(
      record.repositoryRoot,
      path.resolve(record.repositoryRoot, record.workingDirectory),
    ) &&
    typeof record.baseHead === 'string' &&
    /^[a-f0-9]{40,64}$/.test(record.baseHead) &&
    Array.isArray(record.requestedScopes) &&
    record.requestedScopes.every((item) => typeof item === 'string') &&
    Array.isArray(record.writablePaths) &&
    record.writablePaths.every((item) => validWritablePath(worktree, item)) &&
    (record.requestedDependencyMode === 'auto' ||
      record.requestedDependencyMode === 'link' ||
      record.requestedDependencyMode === 'isolated') &&
    (record.dependencyMode === 'link' ||
      record.dependencyMode === 'isolated') &&
    Array.isArray(record.dependencyLinks) &&
    record.dependencyLinks.every((item) =>
      validDependencyLink(record.repositoryRoot, worktree, item),
    ) &&
    typeof record.manifestHash === 'string' &&
    /^[a-f0-9]{64}$/.test(record.manifestHash) &&
    record.backend === 'macos-sandbox-exec' &&
    typeof record.createdAt === 'string' &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.updatedAt === 'string' &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    statuses.has(record.status)
  );
}

export function loadIsolation(id: string): IsolationRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(id), 'utf8')) as unknown;
    return validRecord(parsed, id) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function listIsolations(): IsolationRecord[] {
  if (!existsSync(isolationRootDir())) return [];
  return readdirSync(isolationRootDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .map((entry) => loadIsolation(entry.name))
    .filter((record): record is IsolationRecord => Boolean(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
