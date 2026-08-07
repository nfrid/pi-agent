import { createWorktreeFinisher } from '@pi-dashboard/worktree-manager';
import type { WorktreeRecord } from './model';
import { delegateWorktreeStore } from './records';

const finisher = createWorktreeFinisher<WorktreeRecord>(delegateWorktreeStore, {
  commitAttribution: 'Committed by pi delegate on finishing the task.',
});

/** Generic Git/finish/retire mechanics are implemented by the shared manager. */
export const finishWorktree = finisher.finishWorktree;
export const retireWorktreeSnapshot = finisher.retireWorktreeSnapshot;
export const removeWorktree = finisher.removeWorktree;
export const discardFreshWorktree = finisher.discardFreshWorktree;
