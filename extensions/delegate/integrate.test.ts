import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
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

async function delegated(options: {
  name?: string;
  write?: (worktreePath: string) => void;
}): Promise<WorktreeRecord> {
  const name = options.name ?? 'Do the thing';
  const preparation = await prepareWorktree({ cwd: repository, name });
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

  test('refuses when the parent still holds the work the branch carried', async () => {
    parentWip();
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'added.txt'), 'task\n'),
    });
    const outcome = await mergeBranch(record);
    expect(outcome.merged).toBe(false);
    expect(outcome.blockedPaths).toEqual(['src/value.txt']);
    expect(outcome.reason).toMatch(/carries your uncommitted work/);

    // Committing the parent's side is all it takes; nothing was lost.
    git(repository, ['commit', '-aqm', 'parent work']);
    expect((await mergeBranch(record)).merged).toBe(true);
    expect(
      readFileSync(path.join(repository, 'src', 'added.txt'), 'utf8'),
    ).toBe('task\n');
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

  test('reports a branch that is no longer there', async () => {
    const record = await delegated({ name: 'Deleted later' });
    await removeWorktree(record.id, { deleteBranch: true });
    expect(await branchState(record)).toBe('gone');
    expect((await mergeBranch(record)).reason).toMatch(/no longer exists/);
    expect((await reviewBranch(record)).state).toBe('gone');
  });
});
