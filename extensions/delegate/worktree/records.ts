import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { WorktreeStore } from '@pi-dashboard/worktree-manager';
import { atomicWriteJsonSync } from '../../shared/fs/atomic';
import type { WorktreeRecord } from './model';

const ROOT = 'delegate-worktrees/v2';

/** Keep touch history bounded while retaining the immutable creator. */
export const MAX_RECENT_PARENT_SESSION_IDS = 16;
export const MAX_PARENT_SESSION_ID_CHARS = 512;

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

function recordPath(id: string): string {
  return path.join(worktreeRecordDir(id), 'record.json');
}

function validParentSessionId(sessionId: string): boolean {
  const hasControl = [...sessionId].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  return (
    sessionId.length > 0 &&
    sessionId.length <= MAX_PARENT_SESSION_ID_CHARS &&
    !hasControl
  );
}

export function writeWorktreeRecord(record: WorktreeRecord): void {
  record.updatedAt = new Date().toISOString();
  if (record.creatorSessionId && !validParentSessionId(record.creatorSessionId))
    delete record.creatorSessionId;
  if (record.recentParentSessionIds) {
    record.recentParentSessionIds = [
      ...new Set(record.recentParentSessionIds.filter(validParentSessionId)),
    ].slice(-MAX_RECENT_PARENT_SESSION_IDS);
    if (record.recentParentSessionIds.length === 0)
      delete record.recentParentSessionIds;
  }
  if (record.parentSessionIds) {
    record.parentSessionIds = [
      ...new Set(record.parentSessionIds.filter(validParentSessionId)),
    ].slice(-MAX_RECENT_PARENT_SESSION_IDS);
    if (record.parentSessionIds.length === 0) delete record.parentSessionIds;
  }
  atomicWriteJsonSync(recordPath(record.id), record, { indent: 2 });
}

/** Record the parent Pi session that created or touched this worktree. */
export function touchWorktreeParentSession(
  record: WorktreeRecord,
  sessionId: string | undefined,
): WorktreeRecord {
  if (!sessionId || !validParentSessionId(sessionId)) return record;
  const current = record.recentParentSessionIds ?? [];
  if (current.includes(sessionId)) return record;
  record.recentParentSessionIds = [...current, sessionId].slice(
    -MAX_RECENT_PARENT_SESSION_IDS,
  );
  writeWorktreeRecord(record);
  return record;
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
    (record.creatorSessionId === undefined ||
      (typeof record.creatorSessionId === 'string' &&
        validParentSessionId(record.creatorSessionId))) &&
    (record.recentParentSessionIds === undefined ||
      (Array.isArray(record.recentParentSessionIds) &&
        record.recentParentSessionIds.length <= MAX_RECENT_PARENT_SESSION_IDS &&
        record.recentParentSessionIds.every(validParentSessionId))) &&
    (record.parentSessionIds === undefined ||
      (Array.isArray(record.parentSessionIds) &&
        record.parentSessionIds.length <= MAX_RECENT_PARENT_SESSION_IDS &&
        record.parentSessionIds.every(validParentSessionId))) &&
    typeof record.repositoryRoot === 'string' &&
    path.isAbsolute(record.repositoryRoot) &&
    typeof record.worktreePath === 'string' &&
    path.isAbsolute(record.worktreePath) &&
    typeof record.branch === 'string' &&
    record.branch.length > 0 &&
    (record.ownership === undefined ||
      record.ownership === 'harness' ||
      record.ownership === 'caller') &&
    typeof record.baseHead === 'string' &&
    /^[a-f0-9]{7,64}$/.test(record.baseHead) &&
    (record.headCommit === undefined ||
      (typeof record.headCommit === 'string' &&
        /^[a-f0-9]{7,64}$/.test(record.headCommit))) &&
    (record.integrationBase === undefined ||
      (typeof record.integrationBase === 'string' &&
        /^[a-f0-9]{7,64}$/.test(record.integrationBase))) &&
    (record.integratedBy === undefined ||
      (typeof record.integratedBy === 'string' &&
        SAFE_ID.test(record.integratedBy))) &&
    (record.integratedHead === undefined ||
      (typeof record.integratedHead === 'string' &&
        /^[a-f0-9]{7,64}$/.test(record.integratedHead))) &&
    (record.integratedAt === undefined ||
      (typeof record.integratedAt === 'string' &&
        !Number.isNaN(Date.parse(record.integratedAt)))) &&
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
    // Drop projection metadata from records written by older versions. It was
    // harness policy, not lifecycle state, and must not be revived on rewrite.
    const legacy = parsed as WorktreeRecord & Record<string, unknown>;
    delete legacy.dependencyLinks;
    delete legacy.dependencyProjectionCandidateCount;
    delete legacy.carriedFiles;
    return legacy;
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

/** Adapter for the reusable Git/worktree lifecycle mechanics. */
export const delegateWorktreeStore: WorktreeStore<WorktreeRecord> = {
  loadWorktree,
  writeWorktreeRecord,
  deleteWorktreeRecord,
};
