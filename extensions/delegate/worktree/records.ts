import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { atomicWriteJsonSync } from '../../shared/fs/atomic';
import type { WorktreeRecord } from './model';

const ROOT = 'delegate-worktrees/v2';

export const SAFE_ID = /^[0-9a-f-]{36}$/;

export function delegateStateRoot(): string {
  return (
    process.env.PI_DELEGATE_STATE_DIR ??
    path.join(
      process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state'),
      'pi-agent',
    )
  );
}

export function worktreeRootDir(): string {
  return path.join(delegateStateRoot(), ROOT);
}

export function worktreeRecordDir(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('Invalid worktree identifier');
  return path.join(worktreeRootDir(), id);
}

/** Private retained copies of allowed ignored-file projections for snapshots. */
export function snapshotFilesDir(id: string): string {
  return path.join(worktreeRecordDir(id), 'snapshot-files');
}

function recordPath(id: string): string {
  return path.join(worktreeRecordDir(id), 'record.json');
}

export function writeWorktreeRecord(record: WorktreeRecord): void {
  record.updatedAt = new Date().toISOString();
  atomicWriteJsonSync(recordPath(record.id), record, { indent: 2 });
}

/**
 * Records are our own state, written atomically by this process. They are
 * validated for shape and identity — enough to reject a truncated or foreign
 * file — but not re-verified against the filesystem on every read the way the
 * old security-boundary records were.
 */
function validRecord(value: unknown, id: string): value is WorktreeRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as WorktreeRecord;
  return (
    record.version === 1 &&
    record.id === id &&
    typeof record.repositoryRoot === 'string' &&
    path.isAbsolute(record.repositoryRoot) &&
    typeof record.worktreePath === 'string' &&
    path.isAbsolute(record.worktreePath) &&
    typeof record.branch === 'string' &&
    record.branch.length > 0 &&
    typeof record.baseHead === 'string' &&
    /^[a-f0-9]{7,64}$/.test(record.baseHead) &&
    typeof record.workingDirectory === 'string' &&
    !path.isAbsolute(record.workingDirectory) &&
    (record.status === 'active' ||
      record.status === 'finished' ||
      record.status === 'removed') &&
    (record.runOutcome === undefined ||
      record.runOutcome === 'timed-out' ||
      record.runOutcome === 'aborted' ||
      record.runOutcome === 'error')
  );
}

export function loadWorktree(id: string): WorktreeRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(id), 'utf8')) as unknown;
    if (!validRecord(parsed, id)) return undefined;
    // Records created before lifecycle metrics did not retain this bounded
    // count. Preserve their operational behavior while reporting zero.
    parsed.dependencyProjectionCandidateCount ??= 0;
    return parsed;
  } catch {
    return undefined;
  }
}

export function listWorktrees(): WorktreeRecord[] {
  const root = worktreeRootDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .map((entry) => loadWorktree(entry.name))
    .filter((record): record is WorktreeRecord => Boolean(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function deleteWorktreeRecord(id: string): void {
  rmSync(worktreeRecordDir(id), { recursive: true, force: true });
}
