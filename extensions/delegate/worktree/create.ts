import { existsSync } from 'node:fs';
import {
  canonical,
  createWorktreeCreator,
  isInside,
  validateExistingWorktree,
  WORKTREE_DIR,
} from '@pi-dashboard/worktree-manager';
import type {
  PreparedWorktree,
  WorktreeBase,
  WorktreePreparation,
  WorktreeRecord,
} from './model';
import {
  delegateWorktreeStore,
  listWorktrees,
  writeWorktreeRecord,
} from './records';

const creator = createWorktreeCreator<WorktreeRecord>(delegateWorktreeStore, {
  environmentVariable: 'PI_DELEGATE_WORKTREE',
  carryCommitMessage:
    'Carried uncommitted parent work\n\nApplied by pi delegate so the task starts where the parent actually is.',
});

/** Generic Git/create mechanics are implemented by the shared manager. */
export async function prepareWorktree(options: {
  cwd: string;
  name: string;
  base?: WorktreeBase;
  /** Existing caller-owned Git worktree; no checkout or branch is created. */
  worktreePath?: string;
  parentSessionId?: string;
}): Promise<WorktreePreparation> {
  if (options.worktreePath) {
    try {
      const validated = await validateExistingWorktree({
        cwd: options.cwd,
        worktreePath: options.worktreePath,
      });
      const occupied = listWorktrees().find((record) => {
        if (record.branch === validated.branch) return true;
        try {
          return canonical(record.worktreePath) === validated.worktreePath;
        } catch {
          return false;
        }
      });
      if (occupied)
        return {
          fallbackReason:
            'Caller worktree unavailable: this path is already attached to a delegate session or retained worktree record.',
        };
    } catch (error) {
      return {
        fallbackReason: `Caller worktree unavailable: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }
  }
  const preparation = await creator.prepareWorktree(options);
  if (!preparation.worktree || !options.parentSessionId) return preparation;
  const record = {
    ...preparation.worktree.record,
    creatorSessionId: options.parentSessionId,
  };
  writeWorktreeRecord(record);
  return {
    worktree: { record, env: preparation.worktree.env },
  };
}

/** Delegate session ownership remains caller-specific record metadata. */
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
  if (record.ownership === 'caller')
    throw new Error(
      'The caller-owned worktree for this continuation is unavailable; it will not be recreated.',
    );
  if (record.sessionToken && record.sessionToken !== token)
    throw new Error('This worktree belongs to another delegate session.');
  if (record.status === 'removed')
    throw new Error('This worktree has already been removed.');
  return creator.rehydrateWorktree(record);
}

export { isInside, validateExistingWorktree, WORKTREE_DIR };
