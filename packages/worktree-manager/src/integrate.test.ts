import { describe, expect, it } from 'vitest';
import { createWorktreeIntegrator } from './integrate.js';
import type { WorktreeRecord } from './model.js';

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

describe('worktree review bounds', () => {
  it('reports the outer checkout after a successful submodule merge', async () => {
    const integrator = createWorktreeIntegrator({
      git: async (_cwd, args) => {
        if (
          args.join('\0') ===
          ['merge-base', '--is-ancestor', record.branch, 'HEAD'].join('\0')
        )
          throw new Error('branch is not merged');
        if (args.includes('MERGE_HEAD') || args.includes('CHERRY_PICK_HEAD'))
          throw new Error('no in-progress operation');
        return '';
      },
      gitText: async (_cwd, args) => {
        if (args[0] === 'rev-list') return '1';
        if (args[0] === 'diff' || args[0] === 'ls-files') return '';
        if (
          args[0] === 'rev-parse' &&
          args[1] === '--show-superproject-working-tree'
        )
          return '/outer/repository';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'merged';
        return '';
      },
    });

    await expect(integrator.mergeBranch(record)).resolves.toMatchObject({
      merged: true,
      commit: 'merged',
      superprojectWorkingTree: '/outer/repository',
    });
  });

  it('bounds oversized Git output without creating a large repository', async () => {
    const integrator = createWorktreeIntegrator({
      git: async (_cwd, args) => {
        if (
          args.join('\0') ===
          ['merge-base', '--is-ancestor', record.branch, 'HEAD'].join('\0')
        ) {
          throw new Error('branch is not merged');
        }
        return '';
      },
      gitText: async (_cwd, args) => {
        if (args[0] === 'cherry') return '+ commit';
        if (args[0] === 'rev-list') return 'commit';
        if (args[0] === 'log' || args[0] === 'show') return 'l'.repeat(20_001);
        if (args[0] === 'diff' && args.includes('--stat'))
          return 's'.repeat(20_001);
        if (args[0] === 'diff') return 'd'.repeat(60_001);
        return '';
      },
    });

    for (const review of [
      await integrator.reviewBranch(record),
      await integrator.reviewBranch(record, 'incremental'),
    ]) {
      expect(review).toMatchObject({ state: 'unmerged', truncated: true });
      expect(review.log).toHaveLength(20_000);
      expect(review.stat).toHaveLength(20_000);
      expect(review.diff).toHaveLength(60_000);
    }
  });
});
