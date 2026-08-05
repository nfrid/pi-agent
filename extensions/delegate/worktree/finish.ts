import { existsSync, rmSync } from 'node:fs';
import { git, gitText, splitZ } from './git';
import { type WorktreeRecord, workBase } from './model';
import {
  deleteWorktreeRecord,
  loadWorktree,
  writeWorktreeRecord,
} from './records';

const COMMIT_SUBJECT_MAX = 72;

function commitSubject(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').trim() || 'delegated work';
  return cleaned.length <= COMMIT_SUBJECT_MAX
    ? cleaned
    : `${cleaned.slice(0, COMMIT_SUBJECT_MAX - 1)}…`;
}

/**
 * Commit whatever the agent left behind.
 *
 * The agent is encouraged to commit its own work, but must not be *required*
 * to — a run that ends with edits sitting uncommitted would otherwise strand
 * them in a worktree the parent cannot merge. Committing here makes the branch
 * the single source of truth in every case.
 */
async function commitPendingWork(
  record: WorktreeRecord,
  taskName: string,
): Promise<void> {
  await git(record.worktreePath, ['add', '--all']);
  const staged = await gitText(record.worktreePath, [
    'diff',
    '--cached',
    '--name-only',
  ]);
  if (!staged) return;
  await git(record.worktreePath, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--no-verify',
    '--message',
    `${commitSubject(taskName)}\n\nCommitted by pi delegate on finishing the task.`,
  ]);
}

/**
 * Settle a worktree: commit any leftover work, record what changed, and leave
 * the branch in place for the parent to integrate.
 */
export async function finishWorktree(
  id: string,
  options: {
    taskName: string;
    outcome: 'success' | 'error' | 'aborted' | 'timed-out';
  },
): Promise<WorktreeRecord> {
  const record = loadWorktree(id);
  if (!record) throw new Error(`Unknown worktree ${id}`);
  if (!existsSync(record.worktreePath)) {
    record.status = 'removed';
    record.runOutcome = undefined;
    record.error = 'The worktree directory disappeared before it was finished.';
    writeWorktreeRecord(record);
    return record;
  }

  try {
    // A continuation is allowed to append commits, but it must not replace
    // the previously recorded branch history. Check before committing pending
    // edits so a reset followed by unrelated work cannot overwrite the
    // persisted provenance that integration uses for its safety check.
    if (record.headCommit) {
      try {
        await git(record.worktreePath, [
          'merge-base',
          '--is-ancestor',
          record.headCommit,
          'HEAD',
        ]);
      } catch {
        record.status = 'finished';
        record.error = `Could not settle the worktree branch: its previously recorded head ${record.headCommit.slice(0, 12)} is not an ancestor of the current branch; refusing to replace lifecycle provenance.`;
        if (options.outcome !== 'success') record.runOutcome = options.outcome;
        writeWorktreeRecord(record);
        return record;
      }
    }

    // Even a failed or aborted run may have produced useful partial work, so
    // the branch is settled regardless of outcome.
    await commitPendingWork(record, options.taskName);
    record.headCommit = await gitText(record.worktreePath, [
      'rev-parse',
      'HEAD',
    ]);
    record.changedPaths = splitZ(
      String(
        await git(record.worktreePath, [
          'diff',
          '--name-only',
          '-z',
          workBase(record),
          record.headCommit,
        ]),
      ),
    );
    record.status = 'finished';
    if (options.outcome !== 'success') {
      // A continuation may have left an earlier harness-generated error on the
      // record. Replace it so the persisted outcome describes this attempt,
      // rather than retaining stale diagnostics indefinitely.
      record.runOutcome = options.outcome;
      record.error =
        options.outcome === 'timed-out'
          ? 'The delegate run timed out; the branch holds whatever work was completed.'
          : `The delegate run ended with ${options.outcome}; the branch holds whatever work was completed.`;
    }
  } catch (error) {
    record.status = 'finished';
    record.runOutcome = undefined;
    record.error = `Could not settle the worktree branch: ${error instanceof Error ? error.message : String(error)}`;
  }
  writeWorktreeRecord(record);
  return record;
}

/**
 * Remove a worktree checkout. The branch survives by default — it holds the
 * work — unless the caller asks for it to go too.
 */
/** Retire a clean read-only checkout while retaining its branch as a lightweight snapshot ref. */
export async function retireWorktreeSnapshot(
  id: string,
): Promise<WorktreeRecord> {
  const record = loadWorktree(id);
  if (!record) throw new Error(`Unknown worktree ${id}`);
  if (existsSync(record.worktreePath)) {
    await git(record.repositoryRoot, [
      'worktree',
      'remove',
      '--force',
      record.worktreePath,
    ]);
  }
  await git(record.repositoryRoot, ['worktree', 'prune']).catch(
    () => undefined,
  );
  record.status = 'finished';
  record.snapshot = true;
  writeWorktreeRecord(record);
  return record;
}

async function branchExists(record: WorktreeRecord): Promise<boolean> {
  try {
    await git(record.repositoryRoot, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${record.branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function removeWorktree(
  id: string,
  options: { deleteBranch?: boolean } = {},
): Promise<void> {
  const record = loadWorktree(id);
  if (!record) return;

  if (existsSync(record.worktreePath)) {
    try {
      await git(record.repositoryRoot, [
        'worktree',
        'remove',
        '--force',
        record.worktreePath,
      ]);
    } catch {
      // Keep the record until pruning confirms Git no longer references the
      // checkout; deleting only the directory is not successful cleanup.
      rmSync(record.worktreePath, { recursive: true, force: true });
    }
  }
  await git(record.repositoryRoot, ['worktree', 'prune']);
  if (options.deleteBranch && (await branchExists(record))) {
    try {
      await git(record.repositoryRoot, ['branch', '-D', record.branch]);
    } catch (error) {
      // A concurrent successful deletion is safe to treat as complete. Other
      // failures retain the record as the retry handle for the live ref.
      if (await branchExists(record)) throw error;
    }
  }
  deleteWorktreeRecord(id);
}

/**
 * Drop a worktree prepared for a run that never started. Nothing of value can
 * exist yet, so the branch goes with it.
 */
export async function discardFreshWorktree(
  id: string,
): Promise<{ warning?: string }> {
  try {
    await removeWorktree(id, { deleteBranch: true });
    return {};
  } catch (error) {
    return {
      warning: `Worktree cleanup failed; ${id} was retained for manual removal: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
