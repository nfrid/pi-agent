import type { WorktreeRecord } from './model.js';

/**
 * Caller-owned persistence for worktree lifecycle records.
 *
 * The Git manager does not prescribe a storage format: delegate keeps its
 * durable JSON records, while other callers can persist checkout ownership in
 * their own database.
 */
export interface WorktreeStore<Record extends WorktreeRecord = WorktreeRecord> {
  loadWorktree(id: string): Record | undefined;
  writeWorktreeRecord(record: Record): void;
  deleteWorktreeRecord(id: string): void;
}
