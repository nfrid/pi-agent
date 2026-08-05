import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { configureNativeHooks, git, repository } from './test/worktree-fixture';
import { continuationRecoveryNote, createRun } from './types';
import {
  attachWorktreeSession,
  discardFreshWorktree,
  finishWorktree,
  listWorktrees,
  loadWorktree,
  prepareWorktree,
  rehydrateWorktreeSession,
  removeWorktree,
  restoreWorktreeSession,
  retireWorktreeSnapshot,
  worktreeSummary,
} from './worktree';
import { writeWorktreeRecord } from './worktree/records';
import { finalizeWorktreeRun } from './worktree-lifecycle';

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

  test('honors a custom core.hooksPath and creates child-local setup', async () => {
    configureNativeHooks();
    const worktree = await prepared();
    const child = worktree.record.worktreePath;

    expect(
      readFileSync(
        path.join(child, '.delegate-setup', 'worktree-path'),
        'utf8',
      ),
    ).toBe(`${child}\n`);
    expect(lstatSync(path.join(child, 'node_modules')).isSymbolicLink()).toBe(
      false,
    );
    expect(
      existsSync(path.join(child, 'node_modules', 'hook-local', 'README')),
    ).toBe(true);
    expect(existsSync(path.join(child, '.delegate-build', 'cache.txt'))).toBe(
      true,
    );
    expect(existsSync(path.join(child, '.env'))).toBe(false);
    expect(worktree.record).not.toHaveProperty('dependencyLinks');
    expect(worktree.record).not.toHaveProperty('carriedFiles');
  });

  test('hookless worktrees receive no implicit dependency or environment setup', async () => {
    const worktree = await prepared();
    const child = worktree.record.worktreePath;
    expect(existsSync(path.join(child, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(child, '.env'))).toBe(false);
    const summary = worktreeSummary(worktree.record);
    expect(summary).not.toHaveProperty('dependencyLinkCount');
    expect(summary).not.toHaveProperty('carriedFileCount');
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

  test('isolates setup outputs across concurrent sibling worktrees', async () => {
    configureNativeHooks();
    const first = await prepared({ name: 'Sibling setup one' });
    const second = await prepared({ name: 'Sibling setup two' });
    const firstSetup = path.join(first.record.worktreePath, '.delegate-setup');

    expect(readFileSync(path.join(firstSetup, 'worktree-path'), 'utf8')).toBe(
      `${first.record.worktreePath}\n`,
    );
    expect(
      readFileSync(
        path.join(
          second.record.worktreePath,
          '.delegate-setup',
          'worktree-path',
        ),
        'utf8',
      ),
    ).toBe(`${second.record.worktreePath}\n`);
    rmSync(path.join(first.record.worktreePath, 'node_modules'), {
      recursive: true,
      force: true,
    });
    rmSync(firstSetup, { recursive: true, force: true });
    expect(
      existsSync(
        path.join(
          second.record.worktreePath,
          'node_modules',
          'hook-local',
          'README',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(path.join(repository, 'node_modules', 'fixture', 'index.js')),
    ).toBe(true);
  });

  test('exposes source snapshot metadata without setup projections', async () => {
    const worktree = await prepared({ name: 'Bounded summary' });
    const summary = worktreeSummary(worktree.record);

    expect(summary).toMatchObject({ snapshotBase: 'wip' });
    expect(Object.keys(summary)).not.toContain('carriedFiles');
    expect(Object.keys(summary)).not.toContain('dependencyLinks');
    expect(Object.keys(summary)).not.toContain('dependencyLinkCount');
    expect(Object.keys(summary)).not.toContain('carriedFileCount');
  });

  test('does not put ignored hook setup into delegate commits', async () => {
    configureNativeHooks();
    const worktree = await prepared({ name: 'Ignored setup commit' });
    writeFileSync(
      path.join(worktree.record.worktreePath, 'src', 'delegated.txt'),
      'work\n',
    );
    const record = await finishWorktree(worktree.record.id, {
      taskName: 'Ignored setup commit',
      outcome: 'success',
    });
    const committedPaths = git(repository, [
      'log',
      '--format=',
      '--name-only',
      `${record.baseHead}..${record.headCommit}`,
    ]);
    expect(committedPaths).toContain('src/delegated.txt');
    expect(committedPaths).not.toContain('.delegate-setup');
    expect(committedPaths).not.toContain('.delegate-build');
    expect(committedPaths).not.toContain('node_modules');
  });

  test('reports bounded setup failure and removes its partial worktree and branch', async () => {
    configureNativeHooks({ failCheckout: true });
    const preparation = await prepareWorktree({
      cwd: repository,
      name: 'Failing setup',
    });
    expect(preparation.worktree).toBeUndefined();
    expect(preparation.fallbackReason).toMatch(/checkout\/setup hooks|hook/i);
    expect(preparation.fallbackReason?.length).toBeLessThan(3_000);
    expect(
      existsSync(path.join(repository, '.worktrees', 'failing-setup')),
    ).toBe(false);
    expect(
      git(repository, ['branch', '--list', 'pi/failing-setup']).trim(),
    ).toBe('');
    expect(git(repository, ['worktree', 'list'])).not.toContain('.worktrees');
  });

  test('suppresses hooks for synthetic WIP and finish commits', async () => {
    configureNativeHooks({ failCommit: true });
    writeFileSync(path.join(repository, 'src', 'parent-wip.txt'), 'parent\n');
    const worktree = await prepared({ name: 'Suppressed synthetic commits' });
    writeFileSync(
      path.join(worktree.record.worktreePath, 'src', 'delegated.txt'),
      'work\n',
    );
    const record = await finishWorktree(worktree.record.id, {
      taskName: 'Suppressed synthetic commits',
      outcome: 'success',
    });
    expect(record.carriedWip).toBe(true);
    expect(record.changedPaths).toEqual(['src/delegated.txt']);
  });

  test('reports setup failure outside a repository', async () => {
    const preparation = await prepareWorktree({
      cwd: path.dirname(repository),
      name: 'No repo here',
    });
    expect(preparation.worktree).toBeUndefined();
    expect(preparation.fallbackReason).toMatch(/Worktree unavailable/);
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
    expect(record.runOutcome).toBeUndefined();
    expect(record.changedPaths).toEqual(['src/value.txt']);
    expect(record.headCommit).not.toBe(record.baseHead);
    // Nothing tracked is left pending; ignored native setup stays local and
    // never reaches the parent.
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
    expect(record.runOutcome).toBe('error');
    expect(worktreeSummary(record).hasWork).toBe(true);
  });

  test('keeps the latest failed attempt through repeated continuation and recovery', async () => {
    const worktree = await prepared();
    const timedOut = await finishWorktree(worktree.record.id, {
      taskName: 'Slow task',
      outcome: 'timed-out',
    });
    const failedContinuation = createRun('Failed continuation', undefined, {
      context: 'continuation',
    });
    failedContinuation.state = 'error';
    failedContinuation.exitCode = 1;
    await finalizeWorktreeRun(
      failedContinuation,
      worktree,
      'Failed continuation',
    );

    expect(timedOut.error).toMatch(/timed out/);
    expect(timedOut.runOutcome).toBe('timed-out');
    expect(failedContinuation.worktree?.runOutcome).toBe('error');
    expect(failedContinuation.worktree?.error).toMatch(/ended with error/);
    expect(loadWorktree(worktree.record.id)?.runOutcome).toBe('error');

    const recovered = createRun('Recovered task', undefined, {
      context: 'continuation',
    });
    recovered.state = 'success';
    recovered.exitCode = 0;
    await finalizeWorktreeRun(recovered, worktree, 'Recovered task');

    expect(recovered.worktree?.error).toMatch(/ended with error/);
    expect(recovered.worktree?.runOutcome).toBe('error');
    expect(continuationRecoveryNote(recovered)).toBe(
      'Earlier attempt ended with error; this continuation completed on the same branch.',
    );
    expect(recovered.warnings).toBeUndefined();
  });

  test('keeps legacy error-only records visible to a successful continuation', async () => {
    const worktree = await prepared();
    await finishWorktree(worktree.record.id, {
      taskName: 'Failed task',
      outcome: 'error',
    });
    const legacy = loadWorktree(worktree.record.id);
    if (!legacy) throw new Error('finished worktree was not persisted');
    legacy.runOutcome = undefined;
    writeWorktreeRecord(legacy);

    const recovered = createRun('Recovered task', undefined, {
      context: 'continuation',
    });
    recovered.state = 'success';
    recovered.exitCode = 0;
    await finalizeWorktreeRun(recovered, worktree, 'Recovered task');

    expect(recovered.worktree?.runOutcome).toBeUndefined();
    expect(recovered.worktree?.error).toMatch(/ended with error/);
    expect(continuationRecoveryNote(recovered)).toBe(
      'Earlier attempt ended with error; this continuation completed on the same branch.',
    );
  });

  test('clears an old outcome when the worktree disappears during recovery', async () => {
    const worktree = await prepared();
    await finishWorktree(worktree.record.id, {
      taskName: 'Slow task',
      outcome: 'timed-out',
    });
    rmSync(worktree.record.worktreePath, { recursive: true, force: true });

    const recovered = createRun('Recover the task', undefined, {
      context: 'continuation',
    });
    recovered.state = 'success';
    recovered.exitCode = 0;
    await finalizeWorktreeRun(recovered, worktree, 'Recover the task');

    expect(recovered.worktree?.runOutcome).toBeUndefined();
    expect(recovered.worktree?.error).toMatch(/directory disappeared/);
    expect(recovered.warnings).toContain(recovered.worktree?.error);
    expect(continuationRecoveryNote(recovered)).toBeUndefined();
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

  test('rehydrates a snapshot by rerunning native setup hooks', async () => {
    configureNativeHooks();
    const worktree = await prepared({ name: 'Hooked snapshot' });
    const child = worktree.record.worktreePath;
    expect(
      existsSync(path.join(child, '.delegate-setup', 'worktree-path')),
    ).toBe(true);
    await retireWorktreeSnapshot(worktree.record.id);
    expect(existsSync(child)).toBe(false);
    expect(existsSync(path.join(child, '.delegate-setup'))).toBe(false);

    const rehydrated = await rehydrateWorktreeSession(
      worktree.record,
      'snapshot-token',
    );
    expect(rehydrated.record.snapshot).toBeUndefined();
    expect(
      readFileSync(
        path.join(child, '.delegate-setup', 'worktree-path'),
        'utf8',
      ),
    ).toBe(`${child}\n`);
    expect(lstatSync(path.join(child, 'node_modules')).isSymbolicLink()).toBe(
      false,
    );
  });

  test('retires a successful clean read-only run as a resumable snapshot', async () => {
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'parent WIP\n');
    const worktree = await prepared({ name: 'Snapshot review' });
    const run = createRun('Snapshot review', undefined, { allowWrites: false });
    run.state = 'success';
    run.exitCode = 0;
    await finalizeWorktreeRun(run, worktree, 'Snapshot review');

    expect(run.worktree?.snapshot).toBe(true);
    expect(existsSync(worktree.record.worktreePath)).toBe(false);
    expect(loadWorktree(worktree.record.id)?.snapshot).toBe(true);
    expect(
      git(repository, ['branch', '--list', worktree.record.branch]),
    ).toContain(worktree.record.branch);
    await retireWorktreeSnapshot(worktree.record.id);
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

  test('retains its record when branch deletion fails so cleanup can retry', async () => {
    const worktree = await prepared({ name: 'Retry branch cleanup' });
    const actualBranch = worktree.record.branch;
    const corrupt = loadWorktree(worktree.record.id);
    if (!corrupt) throw new Error('missing worktree record');
    corrupt.branch = git(repository, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]).trim();
    writeWorktreeRecord(corrupt);

    await expect(
      removeWorktree(worktree.record.id, { deleteBranch: true }),
    ).rejects.toThrow();
    expect(loadWorktree(worktree.record.id)).toBeDefined();

    corrupt.branch = actualBranch;
    writeWorktreeRecord(corrupt);
    await removeWorktree(worktree.record.id, { deleteBranch: true });
    expect(loadWorktree(worktree.record.id)).toBeUndefined();
  });

  test('retries stale snapshot cleanup when its branch is already gone', async () => {
    const worktree = await prepared({ name: 'Retry missing snapshot branch' });
    await finishWorktree(worktree.record.id, {
      taskName: 'Retry missing snapshot branch',
      outcome: 'success',
    });
    await retireWorktreeSnapshot(worktree.record.id);
    git(repository, ['branch', '-D', worktree.record.branch]);

    await removeWorktree(worktree.record.id, { deleteBranch: true });
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
