import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { git, repository } from './test/worktree-fixture';
import {
  branchState,
  finishWorktree,
  mergeBranch,
  prepareWorktree,
  removeWorktree,
  reviewBranch,
  type WorktreeRecord,
  workBase,
} from './worktree';
import * as worktreeGit from './worktree/git';

async function delegated(options: {
  name?: string;
  base?: 'wip' | 'head';
  write?: (worktreePath: string) => void;
}): Promise<WorktreeRecord> {
  const name = options.name ?? 'Do the thing';
  const preparation = await prepareWorktree({
    cwd: repository,
    name,
    base: options.base,
  });
  const worktree = preparation.worktree;
  if (!worktree)
    throw new Error(preparation.fallbackReason ?? 'preparation failed');
  options.write?.(worktree.record.worktreePath);
  return finishWorktree(worktree.record.id, {
    taskName: name,
    outcome: 'success',
  });
}

function parentWip(): void {
  writeFileSync(path.join(repository, 'src', 'value.txt'), 'parent edit\n');
}

describe('separating carried parent work from the task own work', () => {
  test('commits the carry so the task starts on a clean tree', async () => {
    parentWip();
    const preparation = await prepareWorktree({
      cwd: repository,
      name: 'Clean start',
    });
    const record = preparation.worktree?.record;
    if (!record) throw new Error('preparation failed');
    expect(record.carriedWip).toBe(true);
    expect(record.carryCommit).toBeDefined();
    expect(workBase(record)).toBe(record.carryCommit);
    // The agent sees the parent's edit as committed history, not as its own
    // pending change, so its own commits describe only its own work.
    expect(
      git(record.worktreePath, ['status', '--porcelain', '-uno']).trim(),
    ).toBe('');
    expect(
      readFileSync(path.join(record.worktreePath, 'src', 'value.txt'), 'utf8'),
    ).toBe('parent edit\n');
  });

  test('reports only what the task changed', async () => {
    parentWip();
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'added.txt'), 'task\n'),
    });
    expect(record.changedPaths).toEqual(['src/added.txt']);
  });

  test('reviews from the carry commit, not from the parent last commit', async () => {
    parentWip();
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'added.txt'), 'task\n'),
    });
    const review = await reviewBranch(record);
    expect(review.state).toBe('unmerged');
    expect(review.diff).toContain('src/added.txt');
    // The parent's own uncommitted edit is not presented as the task's work.
    expect(review.diff).not.toContain('parent edit');
    expect(review.truncated).toBe(false);
  });

  test('says so when the task committed nothing of its own', async () => {
    parentWip();
    const record = await delegated({});
    const review = await reviewBranch(record);
    expect(review.log).toBe('');
  });
});

describe('merging a delegate branch', () => {
  test('lands the work and reports the branch merged afterwards', async () => {
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'value.txt'), 'task\n'),
    });
    const outcome = await mergeBranch(record);
    expect(outcome.merged).toBe(true);
    expect(outcome.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(
      readFileSync(path.join(repository, 'src', 'value.txt'), 'utf8'),
    ).toBe('task\n');
    expect(await branchState(record)).toBe('merged');
    expect((await mergeBranch(record)).reason).toMatch(/already an ancestor/);
  });

  test('integrates only task work while carried parent work stays dirty', async () => {
    parentWip();
    writeFileSync(path.join(repository, 'src', 'carried.txt'), 'carried\n');
    const record = await delegated({
      write: (worktreePath) => {
        // `from: wip` gives the child both kinds of parent work.
        expect(
          readFileSync(path.join(worktreePath, 'src', 'value.txt'), 'utf8'),
        ).toBe('parent edit\n');
        expect(
          readFileSync(path.join(worktreePath, 'src', 'carried.txt'), 'utf8'),
        ).toBe('carried\n');
        writeFileSync(path.join(worktreePath, 'src', 'added.txt'), 'task\n');
      },
    });

    const beforeMerge = git(repository, ['status', '--porcelain']);
    expect(beforeMerge).toContain(' M src/value.txt');
    expect(beforeMerge).toContain('?? src/carried.txt');

    const review = await reviewBranch(record);
    expect(review.diff).toContain('src/added.txt');
    expect(review.diff).not.toContain('parent edit');
    expect(review.diff).not.toContain('src/carried.txt');

    const outcome = await mergeBranch(record);
    expect(outcome.merged).toBe(true);
    expect(
      readFileSync(path.join(repository, 'src', 'added.txt'), 'utf8'),
    ).toBe('task\n');
    expect(
      readFileSync(path.join(repository, 'src', 'value.txt'), 'utf8'),
    ).toBe('parent edit\n');
    expect(
      readFileSync(path.join(repository, 'src', 'carried.txt'), 'utf8'),
    ).toBe('carried\n');
    // The task commit was copied, not a merge of the carry snapshot: parent
    // work remains uncommitted and the untracked carry remains untracked.
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeMerge);
    expect(git(repository, ['show', 'HEAD:src/value.txt'])).toBe('one\n');
    expect(git(repository, ['ls-files', 'src/carried.txt'])).toBe('');
    expect(git(repository, ['diff', '--name-only', '--diff-filter=U'])).toBe(
      '',
    );
    expect(await branchState(record)).toBe('merged');
  });

  test('says when a carried task has no commits to merge', async () => {
    parentWip();
    const record = await delegated({});
    const beforeMerge = git(repository, ['status', '--porcelain']);

    const outcome = await mergeBranch(record);
    expect(outcome.merged).toBe(false);
    expect(outcome.reason).toMatch(/no task commits to merge/);
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeMerge);
  });

  test('refuses a missing carried work base without reviewing or merging it', async () => {
    parentWip();
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'task\n'),
    });
    record.carryCommit = '0'.repeat(40);
    const beforeMerge = git(repository, ['status', '--porcelain']);

    expect(await branchState(record)).toBe('unmerged');
    const review = await reviewBranch(record);
    expect(review).toMatchObject({
      state: 'unmerged',
      error: expect.stringMatching(/no longer resolves/),
      log: '',
      stat: '',
      diff: '',
    });
    await expect(mergeBranch(record)).resolves.toMatchObject({
      merged: false,
      reason: expect.stringMatching(/no longer resolves/),
    });
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeMerge);
    expect(existsSync(path.join(repository, 'src', 'task.txt'))).toBe(false);
  });

  test('refuses a force-moved carried branch instead of cherry-picking it', async () => {
    parentWip();
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'task\n'),
    });
    git(record.worktreePath, ['reset', '--hard', record.baseHead]);
    writeFileSync(
      path.join(record.worktreePath, 'src', 'force-moved.txt'),
      'unrelated\n',
    );
    git(record.worktreePath, ['add', 'src/force-moved.txt']);
    git(record.worktreePath, ['commit', '-m', 'force moved branch']);
    const beforeMerge = git(repository, ['status', '--porcelain']);

    expect(await branchState(record)).toBe('unmerged');
    const review = await reviewBranch(record);
    expect(review).toMatchObject({
      state: 'unmerged',
      error: expect.stringMatching(/not an ancestor/),
      log: '',
      stat: '',
      diff: '',
    });
    const outcome = await mergeBranch(record);
    expect(outcome).toMatchObject({
      merged: false,
      reason: expect.stringMatching(/not an ancestor/),
    });
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeMerge);
    expect(existsSync(path.join(repository, 'src', 'force-moved.txt'))).toBe(
      false,
    );
  });

  test('refuses a missing normal base without reviewing or merging it', async () => {
    const record = await delegated({
      base: 'head',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'task\n'),
    });
    record.baseHead = '0'.repeat(40);
    const beforeMerge = git(repository, ['status', '--porcelain']);

    expect(await branchState(record)).toBe('unmerged');
    const review = await reviewBranch(record);
    expect(review).toMatchObject({
      state: 'unmerged',
      error: expect.stringMatching(/recorded base .*no longer resolves/),
      log: '',
      stat: '',
      diff: '',
    });
    expect(review.error).not.toMatch(/carry|child-only/i);
    await expect(mergeBranch(record)).resolves.toMatchObject({
      merged: false,
      reason: expect.stringMatching(/recorded base .*no longer resolves/),
    });
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeMerge);
    expect(existsSync(path.join(repository, 'src', 'task.txt'))).toBe(false);
  });

  test('refuses a force-moved normal branch before attempting a merge', async () => {
    const record = await delegated({
      base: 'head',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'task\n'),
    });
    const tree = git(record.worktreePath, ['write-tree']).trim();
    const unrelated = git(record.worktreePath, [
      'commit-tree',
      tree,
      '-m',
      'unrelated root',
    ]).trim();
    git(record.worktreePath, ['reset', '--hard', unrelated]);
    writeFileSync(
      path.join(record.worktreePath, 'src', 'force-moved.txt'),
      'unrelated\n',
    );
    git(record.worktreePath, ['add', 'src/force-moved.txt']);
    git(record.worktreePath, ['commit', '-m', 'force moved branch']);
    const beforeMerge = git(repository, ['status', '--porcelain']);

    expect(await branchState(record)).toBe('unmerged');
    const review = await reviewBranch(record);
    expect(review).toMatchObject({
      state: 'unmerged',
      error: expect.stringMatching(/recorded base .*not an ancestor/),
      log: '',
      stat: '',
      diff: '',
    });
    expect(review.error).not.toMatch(/carry|child-only/i);
    const outcome = await mergeBranch(record);
    expect(outcome).toMatchObject({
      merged: false,
      reason: expect.stringMatching(/recorded base .*not an ancestor/),
    });
    expect(outcome.reason).not.toMatch(/cleanup failed|unchanged/);
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeMerge);
    expect(existsSync(path.join(repository, 'src', 'force-moved.txt'))).toBe(
      false,
    );
  });

  test('aborts a conflicting merge and leaves the checkout as it was', async () => {
    const record = await delegated({
      name: 'Conflicting task',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'value.txt'), 'theirs\n'),
    });
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'ours\n');
    git(repository, ['commit', '-aqm', 'parent moved on']);

    const outcome = await mergeBranch(record);
    expect(outcome.merged).toBe(false);
    expect(outcome.conflicted).toEqual(['src/value.txt']);
    expect(outcome.reason).toMatch(/aborted; your checkout is unchanged/);
    expect(
      readFileSync(path.join(repository, 'src', 'value.txt'), 'utf8'),
    ).toBe('ours\n');
    expect(git(repository, ['status', '--porcelain']).trim()).toBe('');
    expect(await branchState(record)).toBe('unmerged');
  });

  test('does not promise an unchanged checkout when cherry-pick cleanup fails', async () => {
    parentWip();
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(
          path.join(worktreePath, 'src', 'conflicted.txt'),
          'theirs\n',
        ),
    });
    writeFileSync(path.join(repository, 'src', 'conflicted.txt'), 'ours\n');
    git(repository, ['add', 'src/conflicted.txt']);
    git(repository, ['commit', '-m', 'parent conflict']);

    const originalGit = worktreeGit.git;
    const gitSpy = vi
      .spyOn(worktreeGit, 'git')
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === 'cherry-pick' && args[1] === '--abort')
          throw new Error('abort intentionally failed');
        return originalGit(cwd, args, options);
      });
    try {
      const outcome = await mergeBranch(record);
      expect(outcome.merged).toBe(false);
      expect(outcome.conflicted).toEqual(['src/conflicted.txt']);
      expect(outcome.reason).toContain(
        'cleanup failed: abort intentionally failed',
      );
      expect(outcome.reason).not.toContain('checkout is unchanged');
      expect(outcome.reason).toContain('git status');
      expect(outcome.reason).toContain('git cherry-pick --abort');
    } finally {
      gitSpy.mockRestore();
      git(repository, ['cherry-pick', '--abort']);
    }
  });

  test('reports a branch that is no longer there', async () => {
    const record = await delegated({ name: 'Deleted later' });
    await removeWorktree(record.id, { deleteBranch: true });
    expect(await branchState(record)).toBe('gone');
    expect((await mergeBranch(record)).reason).toMatch(/no longer exists/);
    expect((await reviewBranch(record)).state).toBe('gone');
  });
});
