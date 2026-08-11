import { existsSync, rmSync } from 'node:fs';
import { validateExistingWorktree, withWorktreePathLock } from './create.js';
import { git, gitText, splitZ } from './git.js';
import { type WorktreeRecord, workBase } from './model.js';
import type { WorktreeStore } from './store.js';

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
  commitAttribution: string,
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
    `${commitSubject(taskName)}\n\n${commitAttribution}`,
  ]);
}

export interface WorktreeFinisherOptions {
  /** Human-readable attribution for synthetic lifecycle commits. */
  commitAttribution?: string;
}

export interface WorktreeFinisher<
  Record extends WorktreeRecord = WorktreeRecord,
> {
  finishWorktree(
    id: string,
    options: {
      taskName: string;
      outcome: 'success' | 'error' | 'aborted' | 'timed-out';
      /** Caller-owned read-only runs must not commit shell-side changes. */
      commitPending?: boolean;
    },
  ): Promise<Record>;
  retireWorktreeSnapshot(id: string): Promise<Record>;
  removeWorktree(
    id: string,
    options?: { deleteBranch?: boolean },
  ): Promise<void>;
  discardFreshWorktree(id: string): Promise<{ warning?: string }>;
}

export function createWorktreeFinisher<
  Record extends WorktreeRecord = WorktreeRecord,
>(
  store: WorktreeStore<Record>,
  options: WorktreeFinisherOptions = {},
): WorktreeFinisher<Record> {
  const commitAttribution =
    options.commitAttribution ??
    'Committed by pi worktree manager on finishing the task.';
  /**
   * Settle a worktree: commit any leftover work, record what changed, and
   * leave the branch in place for the caller to integrate.
   */
  async function finishWorktree(
    id: string,
    options: {
      taskName: string;
      outcome: 'success' | 'error' | 'aborted' | 'timed-out';
      commitPending?: boolean;
    },
  ): Promise<Record> {
    const record = store.loadWorktree(id);
    if (!record) throw new Error(`Unknown worktree ${id}`);
    if (!existsSync(record.worktreePath)) {
      // A caller-owned checkout is never removed or reclassified as a
      // harness-managed resource merely because its path disappeared.
      record.status = record.ownership === 'caller' ? 'finished' : 'removed';
      record.runOutcome = undefined;
      record.error =
        'The worktree directory disappeared before it was finished.';
      store.writeWorktreeRecord(record);
      return record;
    }

    try {
      if (record.ownership === 'caller')
        await validateExistingWorktree({
          cwd: record.repositoryRoot,
          worktreePath: record.worktreePath,
          expectedRepositoryRoot: record.repositoryRoot,
          expectedBranch: record.branch,
          requireClean: false,
          allowRequestedCheckout: record.repositoryRoot === record.worktreePath,
        });

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
          if (options.outcome !== 'success')
            record.runOutcome = options.outcome;
          store.writeWorktreeRecord(record);
          return record;
        }
      }

      const callerReadOnly =
        record.ownership === 'caller' && options.commitPending === false;
      if (callerReadOnly) {
        if (record.ownership === 'caller')
          await validateExistingWorktree({
            cwd: record.repositoryRoot,
            worktreePath: record.worktreePath,
            expectedRepositoryRoot: record.repositoryRoot,
            expectedBranch: record.branch,
            requireClean: true,
            allowRequestedCheckout:
              record.repositoryRoot === record.worktreePath,
          });
        const status = String(
          await git(record.worktreePath, [
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
          ]),
        );
        const currentHead = await gitText(record.worktreePath, [
          'rev-parse',
          'HEAD',
        ]);
        const expectedHead = record.headCommit ?? record.baseHead;
        if (status.trim() || currentHead !== expectedHead) {
          record.status = 'finished';
          record.error =
            'The caller-owned read-only worktree was modified; no caller files or commits were changed by the harness.';
          if (options.outcome !== 'success')
            record.runOutcome = options.outcome;
          store.writeWorktreeRecord(record);
          return record;
        }
        record.headCommit = currentHead;
        record.changedPaths = [];
      } else {
        // Even a failed or aborted run may have produced useful partial work,
        // so the branch is settled regardless of outcome. Caller-owned paths
        // are revalidated while an atomic path lock covers validation and the
        // first Git write, preventing another delegate claim in this process.
        const write = async () => {
          if (record.ownership === 'caller')
            await validateExistingWorktree({
              cwd: record.repositoryRoot,
              worktreePath: record.worktreePath,
              expectedRepositoryRoot: record.repositoryRoot,
              expectedBranch: record.branch,
              requireClean: false,
              allowRequestedCheckout:
                record.repositoryRoot === record.worktreePath,
            });
          await commitPendingWork(record, options.taskName, commitAttribution);
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
        };
        if (record.ownership === 'caller')
          await withWorktreePathLock(record.worktreePath, write);
        else await write();
      }
      record.status = 'finished';
      if (options.outcome !== 'success') {
        // A continuation may have left an earlier harness-generated error on
        // the record. Replace it so the persisted outcome describes this
        // attempt, rather than retaining stale diagnostics indefinitely.
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
    store.writeWorktreeRecord(record);
    return record;
  }

  /** Retire a clean read-only checkout while retaining its branch as a snapshot ref. */
  async function retireWorktreeSnapshot(id: string): Promise<Record> {
    const record = store.loadWorktree(id);
    if (!record) throw new Error(`Unknown worktree ${id}`);
    if (record.ownership === 'caller') {
      // Caller-owned checkouts remain available for the caller and for
      // continuations; only the harness lifecycle record is settled.
      record.status = 'finished';
      delete record.snapshot;
      store.writeWorktreeRecord(record);
      return record;
    }
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
    store.writeWorktreeRecord(record);
    return record;
  }

  async function branchExists(record: Record): Promise<boolean> {
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

  /**
   * Remove a worktree checkout. The branch survives by default — it holds the
   * work — unless the caller asks for it to go too.
   */
  async function removeWorktree(
    id: string,
    options: { deleteBranch?: boolean } = {},
  ): Promise<void> {
    const record = store.loadWorktree(id);
    if (!record) return;

    if (record.ownership === 'caller') {
      if (record.status === 'active')
        throw new Error(
          'Cannot release an active caller-owned worktree; wait for the delegate to settle or use pre-launch cleanup.',
        );
      // Releasing our record is the only cleanup permitted for a caller-owned
      // checkout. Never invoke worktree remove, prune, or branch -D here.
      store.deleteWorktreeRecord(id);
      return;
    }

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
    store.deleteWorktreeRecord(id);
  }

  /**
   * Drop a worktree prepared for a run that never started. Nothing of value can
   * exist yet, so the branch goes with it.
   */
  async function discardFreshWorktree(
    id: string,
  ): Promise<{ warning?: string }> {
    try {
      const record = store.loadWorktree(id);
      if (record?.ownership === 'caller' && record.status === 'active') {
        // This is the sole pre-launch exception: setup created only the
        // harness record, so discard it without touching the caller checkout.
        store.deleteWorktreeRecord(id);
        return {};
      }
      await removeWorktree(id, { deleteBranch: true });
      return {};
    } catch (error) {
      return {
        warning: `Worktree cleanup failed; ${id} was retained for manual removal: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    finishWorktree,
    retireWorktreeSnapshot,
    removeWorktree,
    discardFreshWorktree,
  };
}
