import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { git } from './kernel';
import { processIdentity, withIsolationLock } from './locks';
import {
  isolationRecordDir,
  isolationRootDir,
  loadIsolation,
  writeIsolationRecord,
} from './records';

async function discardIsolationUnlocked(id: string): Promise<void> {
  const record = loadIsolation(id);
  if (!record) {
    if (existsSync(path.join(isolationRootDir(), 'archive', `${id}.json`)))
      return;
    throw new Error('Isolation record not found');
  }
  if (record.status === 'running') {
    if (
      !record.runOwner ||
      processIdentity(record.runOwner.pid) === record.runOwner.identity
    )
      throw new Error('Cannot discard an isolation while its child is running');
    record.status = 'failed';
    record.error = 'Recovered stale running isolation after its owner exited.';
    record.runOwner = undefined;
    writeIsolationRecord(record);
  }
  try {
    await git(record.repositoryRoot, [
      'worktree',
      'unlock',
      record.worktreePath,
    ]);
  } catch {
    // Already-unlocked worktrees remain removable.
  }
  try {
    await git(record.repositoryRoot, [
      'worktree',
      'remove',
      '--force',
      record.worktreePath,
    ]);
  } catch (error) {
    record.status = 'failed';
    record.error = `Isolation cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    writeIsolationRecord(record);
    throw new Error(record.error);
  }
  record.status = 'discarded';
  const archive = path.join(isolationRootDir(), 'archive');
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(archive, `${record.id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  rmSync(isolationRecordDir(id), { recursive: true, force: true });
}

export async function discardIsolation(id: string): Promise<void> {
  return withIsolationLock(id, () => discardIsolationUnlocked(id));
}
