import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { git, repository } from './test/worktree-fixture';
import {
  attachWorktreeSession,
  discardFreshWorktree,
  finishWorktree,
  listWorktrees,
  loadWorktree,
  prepareWorktree,
  removeWorktree,
  restoreWorktreeSession,
  worktreeSummary,
} from './worktree';

async function prepared(
  options: { name?: string; base?: 'wip' | 'head' } = {},
) {
  const preparation = await prepareWorktree({
    cwd: repository,
    name: options.name ?? 'Implement the thing',
    base: options.base,
  });
  const worktree = preparation.worktree;
  if (!worktree)
    throw new Error(preparation.fallbackReason ?? 'preparation failed');
  return worktree;
}

describe('worktree preparation', () => {
  test('creates a named branch nobody else is on', async () => {
    const worktree = await prepared({ name: 'Implement the thing' });
    expect(worktree.record.branch).toBe('pi/implement-the-thing');
    expect(existsSync(worktree.record.worktreePath)).toBe(true);
    expect(
      git(worktree.record.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ).toContain('pi/implement-the-thing');
    // The parent checkout is untouched: that is the whole point.
    expect(
      git(repository, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ).not.toContain('pi/');
  });

  test('gives a second task with the same name its own branch', async () => {
    const first = await prepared({ name: 'Same name' });
    const second = await prepared({ name: 'Same name' });
    expect(second.record.branch).not.toBe(first.record.branch);
    expect(second.record.worktreePath).not.toBe(first.record.worktreePath);
  });

  test('sets the worktree up without per-repo hooks', async () => {
    const worktree = await prepared();
    const root = worktree.record.worktreePath;
    // Dependencies are linked rather than reinstalled...
    expect(lstatSync(path.join(root, 'node_modules')).isSymbolicLink()).toBe(
      true,
    );
    expect(
      existsSync(path.join(root, 'node_modules', 'fixture', 'index.js')),
    ).toBe(true);
    expect(worktree.record.dependencyLinks).toContain('node_modules');
    // ...and gitignored essentials git would never provide are copied in.
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
      'SECRET=local\n',
    );
    expect(worktree.record.carriedFiles).toContain('.env');
  });

  test('keeps the worktree directory out of git status', async () => {
    await prepared();
    expect(git(repository, ['status', '--porcelain'])).not.toContain(
      '.worktrees',
    );
  });

  test('carries the parent uncommitted work in by default', async () => {
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'edited\n');
    writeFileSync(path.join(repository, 'src', 'brand-new.txt'), 'new\n');
    const worktree = await prepared();
    const root = worktree.record.worktreePath;
    expect(worktree.record.carriedWip).toBe(true);
    expect(readFileSync(path.join(root, 'src', 'value.txt'), 'utf8')).toBe(
      'edited\n',
    );
    expect(readFileSync(path.join(root, 'src', 'brand-new.txt'), 'utf8')).toBe(
      'new\n',
    );
  });

  test('starts from the last commit when asked for head', async () => {
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'edited\n');
    const worktree = await prepared({ base: 'head' });
    expect(worktree.record.carriedWip).toBe(false);
    expect(
      readFileSync(
        path.join(worktree.record.worktreePath, 'src', 'value.txt'),
        'utf8',
      ),
    ).toBe('one\n');
  });

  test('falls back with a reason outside a repository', async () => {
    const preparation = await prepareWorktree({
      cwd: path.dirname(repository),
      name: 'No repo here',
    });
    expect(preparation.worktree).toBeUndefined();
    expect(preparation.fallbackReason).toMatch(/parent checkout/);
  });
});

describe('worktree sessions', () => {
  test('restores its own session and rejects another', async () => {
    const worktree = attachWorktreeSession(await prepared(), 'token-a');
    expect(loadWorktree(worktree.record.id)?.sessionToken).toBe('token-a');
    expect(
      restoreWorktreeSession(worktree.record, 'token-a').record.branch,
    ).toBe(worktree.record.branch);
    expect(() => restoreWorktreeSession(worktree.record, 'token-b')).toThrow(
      /another delegate session/,
    );
  });
});

describe('finishing a worktree', () => {
  test('commits whatever the agent left behind and reports the change', async () => {
    const worktree = await prepared({ name: 'Add a feature' });
    writeFileSync(
      path.join(worktree.record.worktreePath, 'src', 'value.txt'),
      'delegated\n',
    );

    const record = await finishWorktree(worktree.record.id, {
      taskName: 'Add a feature',
      outcome: 'success',
    });

    expect(record.status).toBe('finished');
    expect(record.changedPaths).toEqual(['src/value.txt']);
    expect(record.headCommit).not.toBe(record.baseHead);
    // Nothing tracked is left pending; the injected node_modules symlink stays
    // untracked on purpose so it never reaches the parent.
    expect(
      git(worktree.record.worktreePath, [
        'status',
        '--porcelain',
        '--untracked-files=no',
      ]),
    ).toBe('');
    // The branch, not a patch, is the deliverable: the parent can just merge.
    git(repository, ['merge', '--no-edit', '-q', record.branch]);
    expect(
      readFileSync(path.join(repository, 'src', 'value.txt'), 'utf8'),
    ).toBe('delegated\n');
  });

  test('keeps the agent own commits and adds nothing when it committed', async () => {
    const worktree = await prepared();
    const root = worktree.record.worktreePath;
    writeFileSync(path.join(root, 'src', 'value.txt'), 'by the agent\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'agent commit']);

    const record = await finishWorktree(worktree.record.id, {
      taskName: 'Whatever',
      outcome: 'success',
    });
    expect(
      git(root, ['log', '--format=%s', `${record.baseHead}..HEAD`]).trim(),
    ).toBe('agent commit');
  });

  test('still settles the branch after a failed run, and says so', async () => {
    const worktree = await prepared();
    writeFileSync(
      path.join(worktree.record.worktreePath, 'src', 'partial.txt'),
      'half done\n',
    );
    const record = await finishWorktree(worktree.record.id, {
      taskName: 'Broken task',
      outcome: 'error',
    });
    expect(record.changedPaths).toContain('src/partial.txt');
    expect(record.error).toMatch(/ended with error/);
    expect(worktreeSummary(record).hasWork).toBe(true);
  });

  test('reports no work when the agent changed nothing', async () => {
    const worktree = await prepared();
    const record = await finishWorktree(worktree.record.id, {
      taskName: 'Nothing to do',
      outcome: 'success',
    });
    expect(record.changedPaths).toEqual([]);
    expect(worktreeSummary(record).hasWork).toBe(false);
  });
});

describe('cleaning up', () => {
  test('removing the checkout leaves the branch behind', async () => {
    const worktree = await prepared({ name: 'Keep the branch' });
    await finishWorktree(worktree.record.id, {
      taskName: 'Keep the branch',
      outcome: 'success',
    });
    await removeWorktree(worktree.record.id);
    expect(existsSync(worktree.record.worktreePath)).toBe(false);
    expect(
      git(repository, ['branch', '--list', worktree.record.branch]),
    ).toContain('pi/keep-the-branch');
    expect(loadWorktree(worktree.record.id)).toBeUndefined();
  });

  test('discarding an unstarted worktree takes the branch too', async () => {
    const worktree = await prepared({ name: 'Never ran' });
    expect(await discardFreshWorktree(worktree.record.id)).toEqual({});
    expect(existsSync(worktree.record.worktreePath)).toBe(false);
    expect(git(repository, ['branch', '--list', worktree.record.branch])).toBe(
      '',
    );
    expect(listWorktrees()).toEqual([]);
  });
});
