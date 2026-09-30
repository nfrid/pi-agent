import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { formatReview } from './branches';
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
import { loadWorktree, writeWorktreeRecord } from './worktree/records';

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
    expect(review.pathSummary).toBeUndefined();
    expect(formatReview(record, review)).not.toContain('Selectors:');
  });

  test('says so when the task committed nothing of its own', async () => {
    parentWip();
    const record = await delegated({});
    const review = await reviewBranch(record);
    expect(review.log).toBe('');
  });
});

describe('cumulative base-chain integration', () => {
  test('marks integrated ancestors when a descendant lands the cumulative chain', async () => {
    const ancestor = await delegated({
      name: 'Ancestor change',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'ancestor.txt'), 'a\n'),
    });
    if (!ancestor.headCommit) throw new Error('missing ancestor head');
    const preparation = await prepareWorktree({
      cwd: repository,
      name: 'Descendant change',
      baseRef: ancestor.headCommit,
    });
    const descendant = preparation.worktree?.record;
    if (!descendant) throw new Error('descendant preparation failed');
    descendant.integrationBase =
      ancestor.integrationBase ?? ancestor.carryCommit ?? ancestor.baseHead;
    writeWorktreeRecord(descendant);
    writeFileSync(
      path.join(descendant.worktreePath, 'src', 'descendant.txt'),
      'b\n',
    );
    const finished = await finishWorktree(descendant.id, {
      taskName: 'Descendant change',
      outcome: 'success',
    });

    expect((await mergeBranch(finished)).merged).toBe(true);
    const integratedAncestor = loadWorktree(ancestor.id);
    expect(integratedAncestor?.integratedBy).toBe(finished.id);
    expect(integratedAncestor?.integratedHead).toBe(ancestor.headCommit);
    expect(await branchState(integratedAncestor as WorktreeRecord)).toBe(
      'merged',
    );

    writeFileSync(
      path.join(ancestor.worktreePath, 'src', 'ancestor-follow-up.txt'),
      'follow-up\n',
    );
    const continuedAncestor = await finishWorktree(ancestor.id, {
      taskName: 'Ancestor follow-up',
      outcome: 'success',
    });
    expect(continuedAncestor.integratedBy).toBe(finished.id);
    expect(continuedAncestor.headCommit).not.toBe(
      continuedAncestor.integratedHead,
    );
    expect(await branchState(continuedAncestor)).toBe('unmerged');
  });

  test('uses an ancestor squash boundary for a multi-commit cumulative descendant', async () => {
    const ancestor = await delegated({
      name: 'Multi-commit squash ancestor',
      write: (worktreePath) => {
        writeFileSync(path.join(worktreePath, 'src', 'value.txt'), 'a\n');
        git(worktreePath, ['add', 'src/value.txt']);
        git(worktreePath, ['commit', '-m', 'feat(child): first value']);
        writeFileSync(path.join(worktreePath, 'src', 'value.txt'), 'b\n');
        git(worktreePath, ['add', 'src/value.txt']);
        git(worktreePath, ['commit', '-m', 'fix(child): second value']);
      },
    });
    const ancestorHistory = git(ancestor.worktreePath, [
      'log',
      '--format=%s',
      `${workBase(ancestor)}..${ancestor.branch}`,
    ]);
    const descendantPreparation = await prepareWorktree({
      cwd: repository,
      name: 'Multi-commit squash descendant',
      baseRef: ancestor.headCommit,
    });
    const descendant = descendantPreparation.worktree?.record;
    if (!descendant) throw new Error('descendant preparation failed');
    descendant.integrationBase = ancestor.baseHead;
    writeWorktreeRecord(descendant);
    const ancestorSquash = await mergeBranch(ancestor, {
      commitMessage: 'feat(delegate): integrate ancestor values',
    });
    expect(ancestorSquash.merged).toBe(true);
    expect(await branchState(ancestor)).toBe('merged');
    const ancestorIncremental = await reviewBranch(ancestor, 'incremental');
    expect(ancestorIncremental.log).toBe('');
    writeFileSync(
      path.join(descendant.worktreePath, 'src', 'value.txt'),
      'c\n',
    );
    const finished = await finishWorktree(descendant.id, {
      taskName: 'Multi-commit squash descendant',
      outcome: 'success',
    });
    expect(await branchState(finished)).toBe('unmerged');
    const descendantIncremental = await reviewBranch(finished, 'incremental');
    expect(descendantIncremental.log).toContain(
      'Multi-commit squash descendant',
    );
    expect(descendantIncremental.diff).toContain('c');
    expect(descendantIncremental.diff).not.toContain('a\\n');
    expect(descendantIncremental.diff).not.toContain('b\\n');
    const descendantHistory = git(descendant.worktreePath, [
      'log',
      '--format=%s',
      `${ancestor.headCommit}..${descendant.branch}`,
    ]);

    const outcome = await mergeBranch(finished, {
      commitMessage: 'fix(delegate): integrate descendant value',
    });

    expect(outcome.merged).toBe(true);
    expect(
      readFileSync(path.join(repository, 'src', 'value.txt'), 'utf8'),
    ).toBe('c\n');
    expect(git(repository, ['show', '-s', '--format=%s', 'HEAD']).trim()).toBe(
      'fix(delegate): integrate descendant value',
    );
    expect(
      git(descendant.worktreePath, [
        'log',
        '--format=%s',
        `${ancestor.headCommit}..${descendant.branch}`,
      ]),
    ).toBe(descendantHistory);
    expect(
      git(ancestor.worktreePath, [
        'log',
        '--format=%s',
        `${workBase(ancestor)}..${ancestor.branch}`,
      ]),
    ).toBe(ancestorHistory);
    const updatedAncestor = loadWorktree(ancestor.id);
    expect(updatedAncestor?.integratedBy).toBe(finished.id);
    expect(updatedAncestor?.integratedCommit).toBe(outcome.commit);
    expect(await branchState(updatedAncestor as WorktreeRecord)).toBe('merged');
    const parentBranch = git(repository, ['branch', '--show-current']).trim();
    git(repository, [
      'branch',
      'before-descendant',
      ancestorSquash.commit as string,
    ]);
    git(repository, ['checkout', '-q', 'before-descendant']);
    expect(await branchState(updatedAncestor as WorktreeRecord)).toBe(
      'unmerged',
    );
    git(repository, ['checkout', '-q', parentBranch]);
    expect(await branchState(finished)).toBe('merged');
    expect((await reviewBranch(finished, 'incremental')).log).toBe('');
  });

  test('squashes a cumulative base chain without merging child history', async () => {
    const ancestor = await delegated({
      name: 'Squash ancestor',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'ancestor.txt'), 'a\n'),
    });
    if (!ancestor.headCommit) throw new Error('missing ancestor head');
    const preparation = await prepareWorktree({
      cwd: repository,
      name: 'Squash descendant',
      baseRef: ancestor.headCommit,
    });
    const descendant = preparation.worktree?.record;
    if (!descendant) throw new Error('descendant preparation failed');
    descendant.integrationBase =
      ancestor.integrationBase ?? ancestor.carryCommit ?? ancestor.baseHead;
    writeWorktreeRecord(descendant);
    writeFileSync(
      path.join(descendant.worktreePath, 'src', 'descendant.txt'),
      'd\n',
    );
    const finished = await finishWorktree(descendant.id, {
      taskName: 'Squash descendant',
      outcome: 'success',
    });
    const childHead = finished.headCommit;

    const outcome = await mergeBranch(finished, {
      commitMessage: 'feat(delegate): integrate cumulative work',
    });

    expect(outcome.merged).toBe(true);
    expect(
      git(repository, ['rev-list', '--parents', '-n', '1', 'HEAD'])
        .trim()
        .split(' '),
    ).toHaveLength(2);
    expect(git(repository, ['show', '-s', '--format=%s', 'HEAD']).trim()).toBe(
      'feat(delegate): integrate cumulative work',
    );
    expect(git(descendant.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(
      childHead,
    );
    expect(
      readFileSync(path.join(repository, 'src', 'ancestor.txt'), 'utf8'),
    ).toBe('a\n');
    expect(
      readFileSync(path.join(repository, 'src', 'descendant.txt'), 'utf8'),
    ).toBe('d\n');
  });
});

describe('incremental delegate review', () => {
  test('supports summary and literal path-filtered reviews with a patch budget', async () => {
    const selected = 'src/selected;$(not-a-command).txt';
    const record = await delegated({
      name: 'Bounded review',
      write: (worktreePath) => {
        writeFileSync(path.join(worktreePath, selected), 'selected\n');
        writeFileSync(
          path.join(worktreePath, 'src', 'other.txt'),
          `${'other '.repeat(200)}\n`,
        );
      },
    });

    const summary = await reviewBranch(record, {
      summaryOnly: true,
      paths: [selected],
    });
    expect(summary.diff).toBe('');
    expect(summary.stat).toContain(selected);
    expect(summary.stat).not.toContain('other.txt');
    expect(summary.pathSummary).toMatchObject({
      total: 2,
      matched: 1,
      omitted: 1,
      matchedPaths: [selected],
      omittedPaths: ['src/other.txt'],
    });

    const bounded = await reviewBranch(record, {
      paths: [selected],
      patchBudget: 1,
    });
    expect(bounded.diff).toHaveLength(1);
    expect(bounded.patchTruncated).toBe(true);
    expect(bounded.omittedPatchChars).toBeGreaterThan(0);
    expect(bounded.diff).not.toContain('other.txt');

    const noMatch = await reviewBranch(record, {
      paths: ['src/missing.txt'],
    });
    expect(noMatch.log).toContain('Bounded review');
    expect(noMatch.stat).toBe('');
    expect(noMatch.diff).toBe('');
    expect(noMatch.pathSummary).toMatchObject({
      total: 2,
      matched: 0,
      omitted: 2,
    });

    await expect(
      reviewBranch(record, { paths: ['../outside'] }),
    ).rejects.toThrow(/repository-relative/);
    await expect(reviewBranch(record, { patchBudget: 60_001 })).rejects.toThrow(
      /patchBudget/,
    );
    await expect(
      reviewBranch(record, { summaryOnly: true, patchBudget: 1 }),
    ).rejects.toThrow(/cannot be combined/);
  });

  test('keeps the full review default and isolates a continuation fix', async () => {
    const record = await delegated({
      name: 'Initial task',
      write: (worktreePath) =>
        writeFileSync(
          path.join(worktreePath, 'src', 'initial.txt'),
          'initial task\n',
        ),
    });
    expect((await reviewBranch(record)).mode).toBe('full');
    expect((await mergeBranch(record)).merged).toBe(true);

    writeFileSync(
      path.join(record.worktreePath, 'src', 'continuation.txt'),
      'continuation fix\n',
    );
    const continued = await finishWorktree(record.id, {
      taskName: 'Continuation fix',
      outcome: 'success',
    });
    const full = await reviewBranch(continued);
    const incremental = await reviewBranch(continued, 'incremental');

    // Updating the persisted head for a continuation remains safe after the
    // original branch was integrated into the parent.
    expect(full.error).toBeUndefined();
    expect(incremental.error).toBeUndefined();
    expect(full.diff).toContain('initial task');
    expect(full.diff).toContain('continuation fix');
    expect(incremental.mode).toBe('incremental');
    expect(incremental.log).toContain('Continuation fix');
    expect(incremental.diff).toContain('continuation fix');
    expect(incremental.diff).not.toContain('initial task');

    const filteredIncremental = await reviewBranch(continued, {
      incremental: true,
      paths: ['src/initial.txt'],
    });
    expect(filteredIncremental.log).toContain('Continuation fix');
    expect(filteredIncremental.stat).toBe('');
    expect(filteredIncremental.diff).toBe('');
    expect(filteredIncremental.pathSummary).toMatchObject({
      total: 1,
      matched: 0,
      omitted: 1,
    });
  });

  test('uses patch identity for carried work and excludes the carry commit', async () => {
    parentWip();
    const record = await delegated({
      name: 'Carried task',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'task\n'),
    });
    expect((await mergeBranch(record)).merged).toBe(true);
    expect(await branchState(record)).toBe('merged');

    writeFileSync(
      path.join(record.worktreePath, 'src', 'follow-up.txt'),
      'follow-up\n',
    );
    const continued = await finishWorktree(record.id, {
      taskName: 'Carried follow-up',
      outcome: 'success',
    });
    const incremental = await reviewBranch(continued, {
      incremental: true,
    });

    expect(incremental.diff).toContain('follow-up.txt');
    expect(incremental.diff).not.toContain('parent edit');
    expect(incremental.diff).not.toContain('src/task.txt');
    expect(incremental.log).toContain('Carried follow-up');
    expect(incremental.log).not.toContain('Carried uncommitted parent work');
  });

  test('merges only a carried continuation after the initial patch was applied', async () => {
    parentWip();
    const record = await delegated({
      name: 'Carried initial task',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'task\n'),
    });
    expect((await mergeBranch(record)).merged).toBe(true);

    // This parent edit overlaps the already-integrated patch. It must not
    // block a later continuation that touches a different path.
    writeFileSync(
      path.join(repository, 'src', 'task.txt'),
      'parent revision\n',
    );
    writeFileSync(
      path.join(record.worktreePath, 'src', 'continuation.txt'),
      'continuation\n',
    );
    const continued = await finishWorktree(record.id, {
      taskName: 'Carried continuation',
      outcome: 'success',
    });

    const outcome = await mergeBranch(continued);
    expect(outcome.merged).toBe(true);
    expect(git(repository, ['show', '-s', '--format=%s', 'HEAD']).trim()).toBe(
      'Carried continuation',
    );
    expect(git(repository, ['show', 'HEAD:src/task.txt'])).toBe('task\n');
    expect(readFileSync(path.join(repository, 'src', 'task.txt'), 'utf8')).toBe(
      'parent revision\n',
    );
    expect(
      readFileSync(path.join(repository, 'src', 'continuation.txt'), 'utf8'),
    ).toBe('continuation\n');
    expect(git(repository, ['status', '--porcelain'])).toContain(
      ' M src/task.txt',
    );

    const noOp = await mergeBranch(continued);
    expect(noOp).toMatchObject({
      merged: false,
      reason: expect.stringMatching(/already applied to HEAD/),
    });
  });

  test('checks dirty overlap only against an unintegrated carried continuation', async () => {
    parentWip();
    const record = await delegated({
      name: 'Carried dirty continuation',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'task\n'),
    });
    expect((await mergeBranch(record)).merged).toBe(true);

    writeFileSync(
      path.join(record.worktreePath, 'src', 'continuation.txt'),
      'continuation\n',
    );
    const continued = await finishWorktree(record.id, {
      taskName: 'Carried conflicting continuation',
      outcome: 'success',
    });
    writeFileSync(
      path.join(repository, 'src', 'continuation.txt'),
      'parent edit\n',
    );

    const outcome = await mergeBranch(continued);
    expect(outcome).toMatchObject({
      merged: false,
      blockedPaths: ['src/continuation.txt'],
    });
    expect(git(repository, ['status', '--porcelain'])).toContain(
      '?? src/continuation.txt',
    );
  });

  test('reports a clear no-delta result after all task patches are integrated', async () => {
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'done.txt'), 'done\n'),
    });
    expect((await mergeBranch(record)).merged).toBe(true);
    const review = await reviewBranch(record, 'incremental');

    expect(review.log).toBe('');
    expect(review.diff).toBe('');
    expect(formatReview(record, review)).toMatch(
      /no unintegrated task delta relative to current HEAD/i,
    );
  });

  test('never attributes advancing or dirty parent work to the delegate', async () => {
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'delegate\n'),
    });
    writeFileSync(path.join(repository, 'src', 'parent-only.txt'), 'parent\n');
    git(repository, ['add', 'src/parent-only.txt']);
    git(repository, ['commit', '-m', 'unrelated parent advance']);
    writeFileSync(path.join(repository, 'src', 'dirty-only.txt'), 'dirty\n');

    const incremental = await reviewBranch(record, 'incremental');
    expect(incremental.diff).toContain('src/task.txt');
    expect(incremental.diff).not.toContain('parent-only.txt');
    expect(incremental.diff).not.toContain('dirty-only.txt');
    expect(incremental.diff).not.toContain('unrelated parent advance');
  });

  test('uses the same deterministic bound for incremental diffs', async () => {
    const record = await delegated({
      name: 'Large task',
      write: (worktreePath) =>
        writeFileSync(
          path.join(worktreePath, 'src', 'large.txt'),
          'x'.repeat(70_000),
        ),
    });
    const first = await reviewBranch(record, 'incremental');
    const second = await reviewBranch(record, 'incremental');

    expect(first.truncated).toBe(true);
    expect(first.diff).toHaveLength(60_000);
    expect(second).toMatchObject({
      truncated: true,
      diff: first.diff,
    });
  });
});

describe('merging a delegate branch', () => {
  test('squashes a carried-only deletion alongside real task changes', async () => {
    writeFileSync(
      path.join(repository, 'src', 'stash.txt'),
      'base stash file\n',
    );
    git(repository, ['add', 'src/stash.txt']);
    git(repository, ['commit', '-qm', 'add stash fixture']);
    writeFileSync(path.join(repository, 'src', 'stash.txt'), 'saved stash\n');
    git(repository, [
      'stash',
      'push',
      '--include-untracked',
      '-qm',
      'pre-existing',
    ]);
    writeFileSync(
      path.join(repository, 'src', 'carried-only.txt'),
      'carried parent data\n',
    );
    const record = await delegated({
      name: 'Delete carried-only file',
      write: (worktreePath) => {
        rmSync(path.join(worktreePath, 'src', 'carried-only.txt'));
        writeFileSync(
          path.join(worktreePath, 'src', 'added.txt'),
          'task addition\n',
        );
        writeFileSync(
          path.join(worktreePath, 'src', 'value.txt'),
          'task edit\n',
        );
      },
    });
    // The file is in the recorded carry but no longer exists in the parent
    // checkout; deleting it in the task is not a dirty-path overlap.
    rmSync(path.join(repository, 'src', 'carried-only.txt'));
    writeFileSync(path.join(repository, 'src', 'staged-wip.txt'), 'staged\n');
    git(repository, ['add', 'src/staged-wip.txt']);
    writeFileSync(
      path.join(repository, 'src', 'unstaged-wip.txt'),
      'unstaged\n',
    );
    writeFileSync(
      path.join(repository, 'src', 'untracked-wip.txt'),
      'untracked\n',
    );
    const beforeStatus = git(repository, ['status', '--porcelain']);
    const beforeStashes = git(repository, ['stash', 'list']);

    const outcome = await mergeBranch(record, {
      commitMessage: 'fix(delegate): apply effective task paths',
    });

    expect(outcome, outcome.reason).toMatchObject({ merged: true });
    expect(
      git(repository, ['show', '--format=', '--name-status', 'HEAD']),
    ).toContain('A\tsrc/added.txt');
    expect(
      git(repository, ['show', '--format=', '--name-status', 'HEAD']),
    ).toContain('M\tsrc/value.txt');
    expect(
      git(repository, ['show', '--format=', '--name-status', 'HEAD']),
    ).not.toContain('carried-only.txt');
    expect(existsSync(path.join(repository, 'src', 'carried-only.txt'))).toBe(
      false,
    );
    expect(
      git(repository, ['rev-list', '--parents', '-n', '1', 'HEAD'])
        .trim()
        .split(' '),
    ).toHaveLength(2);
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeStatus);
    expect(git(repository, ['stash', 'list'])).toBe(beforeStashes);
    expect(
      readFileSync(path.join(repository, 'src', 'staged-wip.txt'), 'utf8'),
    ).toBe('staged\n');
    expect(
      readFileSync(path.join(repository, 'src', 'unstaged-wip.txt'), 'utf8'),
    ).toBe('unstaged\n');
    expect(
      readFileSync(path.join(repository, 'src', 'untracked-wip.txt'), 'utf8'),
    ).toBe('untracked\n');
  });

  test('squashes a normal tracked deletion', async () => {
    writeFileSync(
      path.join(repository, 'src', 'tracked-delete.txt'),
      'tracked\n',
    );
    git(repository, ['add', 'src/tracked-delete.txt']);
    git(repository, ['commit', '-qm', 'add tracked deletion fixture']);
    const record = await delegated({
      name: 'Squash tracked deletion',
      write: (worktreePath) =>
        rmSync(path.join(worktreePath, 'src', 'tracked-delete.txt')),
    });

    const outcome = await mergeBranch(record, {
      commitMessage: 'fix(delegate): integrate tracked deletion',
    });

    expect(outcome.merged).toBe(true);
    expect(existsSync(path.join(repository, 'src', 'tracked-delete.txt'))).toBe(
      false,
    );
    expect(
      git(repository, ['show', '--format=', '--name-status', 'HEAD']),
    ).toContain('D\tsrc/tracked-delete.txt');
    expect(git(repository, ['status', '--porcelain'])).toBe('');
  });

  test('treats add-then-delete paths as ineffective when other task paths change', async () => {
    const record = await delegated({
      name: 'Squash net-zero path',
      write: (worktreePath) => {
        const temporary = path.join(worktreePath, 'src', 'temporary.txt');
        writeFileSync(temporary, 'temporary\n');
        git(worktreePath, ['add', 'src/temporary.txt']);
        git(worktreePath, ['commit', '-qm', 'add temporary path']);
        rmSync(temporary);
        writeFileSync(
          path.join(worktreePath, 'src', 'real-change.txt'),
          'real\n',
        );
        git(worktreePath, ['add', 'src/real-change.txt']);
        git(worktreePath, [
          'commit',
          '-qm',
          'remove temporary and add real path',
        ]);
      },
    });

    const outcome = await mergeBranch(record, {
      commitMessage: 'fix(delegate): integrate effective paths only',
    });

    expect(outcome.merged).toBe(true);
    expect(
      git(repository, ['show', '--format=', '--name-status', 'HEAD']),
    ).toContain('A\tsrc/real-change.txt');
    expect(
      git(repository, ['show', '--format=', '--name-status', 'HEAD']),
    ).not.toContain('temporary.txt');
    expect(existsSync(path.join(repository, 'src', 'temporary.txt'))).toBe(
      false,
    );
    expect(git(repository, ['status', '--porcelain'])).toBe('');
  });

  test('does not commit an unrelated path staged after task application', async () => {
    const record = await delegated({
      name: 'Squash owned paths only',
      write: (worktreePath) =>
        writeFileSync(
          path.join(worktreePath, 'src', 'task-change.txt'),
          'task\n',
        ),
    });
    const originalGit = worktreeGit.git;
    const gitSpy = vi
      .spyOn(worktreeGit, 'git')
      .mockImplementation(async (cwd, args, options) => {
        const result = await originalGit(cwd, args, options);
        if (args[0] === 'cherry-pick' && args[1] === '--no-commit') {
          writeFileSync(
            path.join(repository, 'src', 'foreign-staged.txt'),
            'outside task ownership\n',
          );
          await originalGit(repository, ['add', 'src/foreign-staged.txt']);
        }
        return result;
      });
    try {
      const outcome = await mergeBranch(record, {
        commitMessage: 'fix(delegate): commit owned paths only',
      });

      expect(outcome.merged).toBe(true);
      expect(
        git(repository, ['show', '--format=', '--name-only', 'HEAD']),
      ).toContain('src/task-change.txt');
      expect(
        git(repository, ['show', '--format=', '--name-only', 'HEAD']),
      ).not.toContain('foreign-staged.txt');
      expect(git(repository, ['diff', '--cached', '--name-status'])).toContain(
        'A\tsrc/foreign-staged.txt',
      );
      expect(
        readFileSync(
          path.join(repository, 'src', 'foreign-staged.txt'),
          'utf8',
        ),
      ).toBe('outside task ownership\n');
    } finally {
      gitSpy.mockRestore();
    }
  });

  test('returns a clean no-op for an empty effective task delta', async () => {
    writeFileSync(path.join(repository, 'src', 'stash.txt'), 'stash base\n');
    git(repository, ['add', 'src/stash.txt']);
    git(repository, ['commit', '-qm', 'add stash fixture']);
    writeFileSync(path.join(repository, 'src', 'stash.txt'), 'saved stash\n');
    git(repository, [
      'stash',
      'push',
      '--include-untracked',
      '-qm',
      'pre-existing',
    ]);
    const record = await delegated({
      name: 'Squash empty effective delta',
      write: (worktreePath) => {
        const temporary = path.join(worktreePath, 'src', 'temporary.txt');
        writeFileSync(temporary, 'temporary\n');
        git(worktreePath, ['add', 'src/temporary.txt']);
        git(worktreePath, ['commit', '-qm', 'add temporary path']);
        rmSync(temporary);
        git(worktreePath, ['add', '-u', 'src/temporary.txt']);
        git(worktreePath, ['commit', '-qm', 'delete temporary path']);
      },
    });
    writeFileSync(path.join(repository, 'src', 'staged-wip.txt'), 'staged\n');
    git(repository, ['add', 'src/staged-wip.txt']);
    writeFileSync(
      path.join(repository, 'src', 'unstaged-wip.txt'),
      'unstaged\n',
    );
    writeFileSync(
      path.join(repository, 'src', 'untracked-wip.txt'),
      'untracked\n',
    );
    const beforeHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const beforeStatus = git(repository, ['status', '--porcelain']);
    const beforeStashes = git(repository, ['stash', 'list']);

    const outcome = await mergeBranch(record, {
      commitMessage: 'fix(delegate): no effective change',
    });

    expect(outcome).toMatchObject({
      merged: false,
      reason: expect.stringMatching(
        /no effective changes to squash.*unchanged/,
      ),
    });
    expect(git(repository, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeStatus);
    expect(git(repository, ['stash', 'list'])).toBe(beforeStashes);
    expect(git(repository, ['diff', '--cached', '--name-only'])).toBe(
      'src/staged-wip.txt\n',
    );
    expect(() =>
      git(repository, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']),
    ).toThrow();
    expect(existsSync(path.join(repository, 'src', 'temporary.txt'))).toBe(
      false,
    );
    expect(existsSync(path.join(repository, 'src', 'untracked-wip.txt'))).toBe(
      true,
    );
  });

  test('preserves unrelated staged state on an empty effective delta', async () => {
    const record = await delegated({
      name: 'Squash empty delta with foreign stage',
      write: (worktreePath) => {
        const temporary = path.join(worktreePath, 'src', 'temporary.txt');
        writeFileSync(temporary, 'temporary\n');
        git(worktreePath, ['add', 'src/temporary.txt']);
        git(worktreePath, ['commit', '-qm', 'add temporary path']);
        rmSync(temporary);
        git(worktreePath, ['add', '-u', 'src/temporary.txt']);
        git(worktreePath, ['commit', '-qm', 'delete temporary path']);
      },
    });
    const beforeHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const originalGit = worktreeGit.git;
    const gitSpy = vi
      .spyOn(worktreeGit, 'git')
      .mockImplementation(async (cwd, args, options) => {
        const result = await originalGit(cwd, args, options);
        if (args[0] === 'cherry-pick' && args[1] === '--no-commit') {
          writeFileSync(
            path.join(repository, 'src', 'foreign-staged.txt'),
            'outside task ownership\n',
          );
          await originalGit(repository, ['add', 'src/foreign-staged.txt']);
        }
        return result;
      });
    try {
      const outcome = await mergeBranch(record, {
        commitMessage: 'fix(delegate): preserve staged state on no-op',
      });

      expect(outcome).toMatchObject({
        merged: false,
        reason: expect.stringMatching(
          /no effective changes to squash.*unchanged/,
        ),
      });
      expect(git(repository, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
      expect(git(repository, ['diff', '--cached', '--name-status'])).toBe(
        'A\tsrc/foreign-staged.txt\n',
      );
      expect(
        readFileSync(
          path.join(repository, 'src', 'foreign-staged.txt'),
          'utf8',
        ),
      ).toBe('outside task ownership\n');
      expect(() =>
        git(repository, [
          'rev-parse',
          '--verify',
          '--quiet',
          'CHERRY_PICK_HEAD',
        ]),
      ).toThrow();
      expect(
        existsSync(
          git(repository, ['rev-parse', '--git-path', 'sequencer']).trim(),
        ),
      ).toBe(false);
    } finally {
      gitSpy.mockRestore();
    }
  });

  test('keeps the rename source endpoint in the dirty-overlap guard', async () => {
    writeFileSync(
      path.join(repository, 'src', 'rename-source.txt'),
      'rename\n',
    );
    git(repository, ['add', 'src/rename-source.txt']);
    git(repository, ['commit', '-qm', 'add rename source']);
    const record = await delegated({
      name: 'Overlapping squash rename',
      write: (worktreePath) =>
        git(worktreePath, [
          'mv',
          'src/rename-source.txt',
          'src/rename-destination.txt',
        ]),
    });
    writeFileSync(
      path.join(repository, 'src', 'rename-source.txt'),
      'parent edit\n',
    );
    const beforeHead = git(repository, ['rev-parse', 'HEAD']);
    const beforeStatus = git(repository, ['status', '--porcelain']);

    const outcome = await mergeBranch(record, {
      commitMessage: 'fix(delegate): integrate overlapping rename',
    });

    expect(outcome).toMatchObject({
      merged: false,
      blockedPaths: ['src/rename-source.txt'],
    });
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeStatus);
  });

  test('squashes both endpoints of a task-owned rename', async () => {
    writeFileSync(
      path.join(repository, 'src', 'rename-source.txt'),
      'rename\n',
    );
    git(repository, ['add', 'src/rename-source.txt']);
    git(repository, ['commit', '-qm', 'add rename source']);
    const record = await delegated({
      name: 'Squash rename',
      write: (worktreePath) =>
        git(worktreePath, [
          'mv',
          'src/rename-source.txt',
          'src/rename-destination.txt',
        ]),
    });

    const outcome = await mergeBranch(record, {
      commitMessage: 'fix(delegate): integrate rename',
    });

    expect(outcome.merged).toBe(true);
    expect(existsSync(path.join(repository, 'src', 'rename-source.txt'))).toBe(
      false,
    );
    expect(
      readFileSync(
        path.join(repository, 'src', 'rename-destination.txt'),
        'utf8',
      ),
    ).toBe('rename\n');
    expect(git(repository, ['diff', '--cached', '--name-status'])).toBe('');
    expect(git(repository, ['status', '--porcelain'])).toBe('');
    expect(
      git(repository, [
        'show',
        '--format=',
        '--name-status',
        '--no-renames',
        'HEAD',
      ]),
    ).toContain('D\tsrc/rename-source.txt');
    expect(
      git(repository, [
        'show',
        '--format=',
        '--name-status',
        '--no-renames',
        'HEAD',
      ]),
    ).toContain('A\tsrc/rename-destination.txt');
  });

  test('squashes reviewed work into one parent commit without child history or WIP', async () => {
    parentWip();
    git(repository, ['add', 'src/value.txt']);
    writeFileSync(path.join(repository, 'src', 'carried.txt'), 'carried\n');
    const record = await delegated({
      name: 'Squash task',
      write: (worktreePath) => {
        writeFileSync(path.join(worktreePath, 'src', 'first.txt'), 'first\n');
        git(worktreePath, ['add', 'src/first.txt']);
        git(worktreePath, [
          'commit',
          '-m',
          'chore(child): first internal step',
        ]);
        writeFileSync(path.join(worktreePath, 'src', 'second.txt'), 'second\n');
        git(worktreePath, ['add', 'src/second.txt']);
        git(worktreePath, ['commit', '-m', 'fix(child): second internal step']);
      },
    });
    const childHead = git(record.worktreePath, ['rev-parse', 'HEAD']);
    const childHistory = git(record.worktreePath, [
      'log',
      '--format=%s',
      `${workBase(record)}..${record.branch}`,
    ]);
    const parentStatus = git(repository, ['status', '--porcelain']);

    const outcome = await mergeBranch(record, {
      commitMessage: 'feat(delegate): integrate reviewed task',
    });

    expect(outcome.merged).toBe(true);
    expect(git(repository, ['show', '-s', '--format=%s', 'HEAD']).trim()).toBe(
      'feat(delegate): integrate reviewed task',
    );
    expect(
      git(repository, ['rev-list', '--parents', '-n', '1', 'HEAD'])
        .trim()
        .split(' '),
    ).toHaveLength(2);
    expect(git(record.worktreePath, ['rev-parse', 'HEAD'])).toBe(childHead);
    expect(
      git(record.worktreePath, [
        'log',
        '--format=%s',
        `${workBase(record)}..${record.branch}`,
      ]),
    ).toBe(childHistory);
    expect(git(repository, ['status', '--porcelain'])).toBe(parentStatus);
    expect(
      readFileSync(path.join(repository, 'src', 'value.txt'), 'utf8'),
    ).toBe('parent edit\n');
    expect(
      readFileSync(path.join(repository, 'src', 'carried.txt'), 'utf8'),
    ).toBe('carried\n');
    expect(
      readFileSync(path.join(repository, 'src', 'first.txt'), 'utf8'),
    ).toBe('first\n');
    expect(
      readFileSync(path.join(repository, 'src', 'second.txt'), 'utf8'),
    ).toBe('second\n');
  });

  test('squash continuation starts after the prior squashed child tip', async () => {
    const record = await delegated({
      name: 'Squash continuation',
      write: (worktreePath) =>
        writeFileSync(
          path.join(worktreePath, 'src', 'initial.txt'),
          'initial\n',
        ),
    });
    const firstOutcome = await mergeBranch(record, {
      commitMessage: 'feat(delegate): integrate initial',
    });
    expect(firstOutcome.merged).toBe(true);
    const firstParentCommit = git(repository, ['rev-parse', 'HEAD']);
    const repeated = await mergeBranch(record, {
      commitMessage: 'feat(delegate): repeat initial',
    });
    expect(repeated).toMatchObject({
      merged: false,
      reason: expect.stringMatching(/no task commits|already applied/),
    });
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(firstParentCommit);
    const priorIntegratedHead = record.integratedHead;
    writeFileSync(
      path.join(record.worktreePath, 'src', 'follow-up.txt'),
      'follow-up\n',
    );
    const continued = await finishWorktree(record.id, {
      taskName: 'Squash continuation',
      outcome: 'success',
    });
    expect(continued.integratedHead).toBe(priorIntegratedHead);

    const outcome = await mergeBranch(continued, {
      commitMessage: 'fix(delegate): integrate continuation',
    });

    expect(outcome.merged).toBe(true);
    expect(git(repository, ['show', '-s', '--format=%s', 'HEAD']).trim()).toBe(
      'fix(delegate): integrate continuation',
    );
    expect(
      readFileSync(path.join(repository, 'src', 'initial.txt'), 'utf8'),
    ).toBe('initial\n');
    expect(
      readFileSync(path.join(repository, 'src', 'follow-up.txt'), 'utf8'),
    ).toBe('follow-up\n');
  });

  test('blocks dirty overlap before squash and leaves the checkout untouched', async () => {
    const record = await delegated({
      name: 'Squash dirty overlap',
      write: (worktreePath) =>
        writeFileSync(
          path.join(worktreePath, 'src', 'overlap.txt'),
          'delegate\n',
        ),
    });
    writeFileSync(path.join(repository, 'src', 'overlap.txt'), 'parent\n');
    const beforeHead = git(repository, ['rev-parse', 'HEAD']);
    const beforeStatus = git(repository, ['status', '--porcelain']);

    const outcome = await mergeBranch(record, {
      commitMessage: 'feat(delegate): integrate overlap',
    });

    expect(outcome).toMatchObject({
      merged: false,
      blockedPaths: ['src/overlap.txt'],
    });
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeStatus);
  });

  test('aborts a conflicting squash and restores the parent checkout', async () => {
    const record = await delegated({
      name: 'Squash conflict',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'value.txt'), 'theirs\n'),
    });
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'ours\n');
    git(repository, ['commit', '-aqm', 'parent moved on']);
    writeFileSync(
      path.join(repository, 'src', 'staged-conflict-wip.txt'),
      'staged\n',
    );
    git(repository, ['add', 'src/staged-conflict-wip.txt']);
    writeFileSync(
      path.join(repository, 'src', 'unstaged-conflict-wip.txt'),
      'unstaged\n',
    );
    writeFileSync(
      path.join(repository, 'src', 'untracked-conflict-wip.txt'),
      'untracked\n',
    );
    const beforeHead = git(repository, ['rev-parse', 'HEAD']);
    const beforeStatus = git(repository, ['status', '--porcelain']);

    const outcome = await mergeBranch(record, {
      commitMessage: 'feat(delegate): integrate conflict',
    });

    expect(outcome).toMatchObject({
      merged: false,
      conflicted: ['src/value.txt'],
      reason: expect.stringMatching(/aborted; your checkout is unchanged/),
    });
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeStatus);
    expect(
      readFileSync(path.join(repository, 'src', 'value.txt'), 'utf8'),
    ).toBe('ours\n');
  });

  test('cleans up when the parent squash commit fails', async () => {
    const record = await delegated({
      name: 'Squash commit failure',
      write: (worktreePath) =>
        writeFileSync(
          path.join(worktreePath, 'src', 'commit-failure.txt'),
          'work\n',
        ),
    });
    writeFileSync(
      path.join(repository, 'src', 'staged-parent-wip.txt'),
      'staged\n',
    );
    git(repository, ['add', 'src/staged-parent-wip.txt']);
    writeFileSync(
      path.join(repository, 'src', 'unstaged-parent-wip.txt'),
      'unstaged\n',
    );
    writeFileSync(
      path.join(repository, 'src', 'untracked-parent-wip.txt'),
      'untracked\n',
    );
    const beforeHead = git(repository, ['rev-parse', 'HEAD']);
    const beforeStatus = git(repository, ['status', '--porcelain']);
    const originalGit = worktreeGit.git;
    const gitSpy = vi
      .spyOn(worktreeGit, 'git')
      .mockImplementation(async (cwd, args, options) => {
        if (args.includes('--only') && args.includes('commit'))
          throw new Error('commit intentionally failed');
        return originalGit(cwd, args, options);
      });
    try {
      const outcome = await mergeBranch(record, {
        commitMessage: 'feat(delegate): integrate failed commit',
      });
      expect(outcome).toMatchObject({
        merged: false,
        reason: expect.stringMatching(/failed and was aborted/),
      });
      expect(git(repository, ['rev-parse', 'HEAD'])).toBe(beforeHead);
      expect(git(repository, ['status', '--porcelain'])).toBe(beforeStatus);
      expect(
        existsSync(path.join(repository, 'src', 'commit-failure.txt')),
      ).toBe(false);
    } finally {
      gitSpy.mockRestore();
    }
  });

  test('preserves landed commit metadata when WIP restoration warns', async () => {
    const record = await delegated({
      name: 'Squash restore warning',
      write: (worktreePath) =>
        writeFileSync(
          path.join(worktreePath, 'src', 'restore-warning.txt'),
          'work\n',
        ),
    });
    writeFileSync(
      path.join(repository, 'src', 'parent-before-restore.txt'),
      'parent\n',
    );
    const originalGit = worktreeGit.git;
    const gitSpy = vi
      .spyOn(worktreeGit, 'git')
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === 'stash' && args[1] === 'pop')
          throw new Error('restore intentionally failed');
        return originalGit(cwd, args, options);
      });
    try {
      const outcome = await mergeBranch(record, {
        commitMessage: 'feat(delegate): integrate restore warning',
      });
      expect(outcome).toMatchObject({
        merged: true,
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        warning: expect.stringMatching(
          /restoring pre-existing parent WIP failed/,
        ),
      });
      expect(record.integratedCommit).toBe(outcome.commit);
      expect(
        git(repository, ['show', '-s', '--format=%s', 'HEAD']).trim(),
      ).toBe('feat(delegate): integrate restore warning');
    } finally {
      gitSpy.mockRestore();
      git(repository, ['stash', 'pop', '--index']);
    }
  });

  test('does not report WIP restoration for a post-success diagnostic warning', async () => {
    const record = await delegated({
      name: 'Squash diagnostic warning',
      write: (worktreePath) =>
        writeFileSync(
          path.join(worktreePath, 'src', 'diagnostic-warning.txt'),
          'work\n',
        ),
    });
    const originalGitText = worktreeGit.gitText;
    let headLookup = 0;
    const gitTextSpy = vi
      .spyOn(worktreeGit, 'gitText')
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD' && headLookup++ === 0)
          throw new Error('diagnostic intentionally failed');
        return originalGitText(cwd, args, options);
      });
    try {
      const outcome = await mergeBranch(record, {
        commitMessage: 'feat(delegate): integrate diagnostic warning',
      });
      expect(outcome).toMatchObject({
        merged: true,
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        warning: expect.stringMatching(/post-integration diagnostics failed/),
      });
      expect(outcome.warning).not.toMatch(/restoring pre-existing parent WIP/);
    } finally {
      gitTextSpy.mockRestore();
    }
  });

  test('requires a parent message before squash integration', async () => {
    const record = await delegated({
      name: 'Message required',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'message.txt'), 'work\n'),
    });
    const before = git(repository, ['rev-parse', 'HEAD']);
    const outcome = await mergeBranch(record, { commitMessage: '   ' });
    expect(outcome).toMatchObject({
      merged: false,
      reason: expect.stringMatching(/nonempty parent commit message/),
    });
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(before);
  });

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

  test('refuses a carried reset-to-carry replacement instead of cherry-picking it', async () => {
    parentWip();
    const record = await delegated({
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'task\n'),
    });
    git(record.worktreePath, ['reset', '--hard', workBase(record)]);
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
      error: expect.stringMatching(
        /previously recorded head .*not an ancestor/,
      ),
      log: '',
      stat: '',
      diff: '',
    });
    const outcome = await mergeBranch(record);
    expect(outcome).toMatchObject({
      merged: false,
      reason: expect.stringMatching(
        /previously recorded head .*not an ancestor/,
      ),
    });
    expect(git(repository, ['status', '--porcelain'])).toBe(beforeMerge);
    expect(existsSync(path.join(repository, 'src', 'force-moved.txt'))).toBe(
      false,
    );
  });

  test('refuses a normal reset-to-base replacement instead of merging it', async () => {
    const record = await delegated({
      base: 'head',
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

    expect(await branchState(record)).toBe('unmerged');
    const review = await reviewBranch(record);
    expect(review.error).toMatch(/previously recorded head .*not an ancestor/);
    expect(review.log).toBe('');
    const outcome = await mergeBranch(record);
    expect(outcome.merged).toBe(false);
    expect(outcome.reason).toMatch(
      /previously recorded head .*not an ancestor/,
    );
    expect(existsSync(path.join(repository, 'src', 'force-moved.txt'))).toBe(
      false,
    );
  });

  test('refuses a reset during continuation before replacing recorded provenance', async () => {
    const record = await delegated({
      base: 'head',
      write: (worktreePath) =>
        writeFileSync(path.join(worktreePath, 'src', 'task.txt'), 'task\n'),
    });
    expect((await mergeBranch(record)).merged).toBe(true);
    git(record.worktreePath, ['reset', '--hard', record.baseHead]);
    writeFileSync(
      path.join(record.worktreePath, 'src', 'replacement.txt'),
      'unrelated\n',
    );
    const continued = await finishWorktree(record.id, {
      taskName: 'Rewritten continuation',
      outcome: 'success',
    });

    expect(continued.headCommit).toBe(record.headCommit);
    expect(continued.error).toMatch(
      /previously recorded head .*not an ancestor/,
    );
    expect((await reviewBranch(continued)).error).toMatch(
      /previously recorded head .*not an ancestor/,
    );
    expect((await mergeBranch(continued)).merged).toBe(false);
    expect(existsSync(path.join(repository, 'src', 'replacement.txt'))).toBe(
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
    const incremental = await reviewBranch(record, 'incremental');
    expect(incremental).toMatchObject({
      mode: 'incremental',
      state: 'unmerged',
      error: expect.stringMatching(/recorded base .*not an ancestor/),
      log: '',
      stat: '',
      diff: '',
    });
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
