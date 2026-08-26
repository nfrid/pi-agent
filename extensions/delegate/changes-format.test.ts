import { describe, expect, it } from 'vitest';
import { formatReview } from './branches';
import type { BranchReview, WorktreeRecord } from './worktree';

const record: WorktreeRecord = {
  version: 1,
  id: 'task',
  repositoryRoot: '/repository',
  worktreePath: '/repository-task',
  workingDirectory: '',
  branch: 'task',
  baseHead: 'base',
  base: 'head',
  carriedWip: false,
  status: 'finished',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('branch review formatting', () => {
  it('marks a truncated incremental review and points to the task branch', () => {
    const review: BranchReview = {
      state: 'unmerged',
      mode: 'incremental',
      log: 'commit',
      stat: 'file | 1 +',
      diff: 'patch',
      truncated: true,
    };

    expect(formatReview(record, review)).toContain(
      '[review truncated — log/stat/diff output is bounded; inspect the complete task branch with: git -C /repository log --oneline base..task]',
    );
  });
});
