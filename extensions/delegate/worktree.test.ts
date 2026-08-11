import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { getDelegateLifecycle, setDelegateLifecycle } from './lifecycle';
import { createDelegateSession, removeDelegateSession } from './session';
import { configureNativeHooks, git, repository } from './test/worktree-fixture';
import { continuationRecoveryNote, createRun } from './types';
import {
  attachWorktreeSession,
  discardFreshWorktree,
  finishWorktree,
  listWorktrees,
  loadWorktree,
  mergeBranch,
  prepareWorktree,
  rehydrateWorktreeSession,
  removeWorktree,
  restoreWorktreeSession,
  retireWorktreeSnapshot,
  touchWorktreeParentSession,
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

describe('caller-owned worktree selection', () => {
  function callerPath(): string {
    return path.join(path.dirname(repository), 'caller-owned');
  }

  function createCallerWorktree(): string {
    const selected = callerPath();
    git(repository, [
      'worktree',
      'add',
      '-q',
      '-b',
      'caller/owned',
      selected,
      'HEAD',
    ]);
    return selected;
  }

  test('uses a clean existing linked worktree without nesting or owning cleanup', async () => {
    const selected = createCallerWorktree();
    try {
      const preparation = await prepareWorktree({
        cwd: repository,
        name: 'Caller checkout',
        worktreePath: selected,
      });
      if (!preparation.worktree)
        throw new Error(preparation.fallbackReason ?? 'preparation failed');
      const record = preparation.worktree.record;
      expect(record.ownership).toBe('caller');
      expect(record.worktreePath).toBe(selected);
      expect(record.branch).toBe('caller/owned');
      expect(existsSync(path.join(repository, '.worktrees'))).toBe(false);

      writeFileSync(path.join(selected, 'caller-change.txt'), 'delegated\\n');
      const finished = await finishWorktree(record.id, {
        taskName: 'Caller checkout',
        outcome: 'success',
        commitPending: true,
      });
      expect(finished.ownership).toBe('caller');
      expect(finished.changedPaths).toContain('caller-change.txt');
      expect((await mergeBranch(finished)).reason).toMatch(/caller-owned/);

      await removeWorktree(record.id, { deleteBranch: true });
      expect(existsSync(selected)).toBe(true);
      expect(git(repository, ['branch', '--list', 'caller/owned'])).toContain(
        'caller/owned',
      );
      expect(loadWorktree(record.id)).toBeUndefined();
    } finally {
      git(repository, ['worktree', 'remove', '--force', selected]);
      git(repository, ['branch', '-D', 'caller/owned']);
    }
  });

  test('rejects the main checkout, dirty paths, and duplicate ownership', async () => {
    const selected = createCallerWorktree();
    try {
      const main = await prepareWorktree({
        cwd: repository,
        name: 'Main checkout',
        worktreePath: repository,
      });
      expect(main.worktree).toBeUndefined();
      expect(main.fallbackReason).toMatch(/must not be the requested checkout/);

      writeFileSync(path.join(selected, 'dirty.txt'), 'dirty\\n');
      const dirty = await prepareWorktree({
        cwd: repository,
        name: 'Dirty checkout',
        worktreePath: selected,
      });
      expect(dirty.worktree).toBeUndefined();
      expect(dirty.fallbackReason).toMatch(/must be clean/);
      rmSync(path.join(selected, 'dirty.txt'));

      const first = await prepareWorktree({
        cwd: repository,
        name: 'First checkout',
        worktreePath: selected,
      });
      expect(first.worktree).toBeDefined();
      const duplicate = await prepareWorktree({
        cwd: repository,
        name: 'Duplicate checkout',
        worktreePath: selected,
      });
      expect(duplicate.worktree).toBeUndefined();
      expect(duplicate.fallbackReason).toMatch(/already attached/);
      if (first.worktree) await removeWorktree(first.worktree.record.id);
    } finally {
      git(repository, ['worktree', 'remove', '--force', selected]);
      git(repository, ['branch', '-D', 'caller/owned']);
    }
  });
});

describe('worktree preparation', () => {
  test('persists bounded parent-session touch identity across continuation rehydration', async () => {
    const worktree = await prepareWorktree({
      cwd: repository,
      name: 'Session identity',
      parentSessionId: 'parent-a',
    });
    if (!worktree.worktree)
      throw new Error(worktree.fallbackReason ?? 'preparation failed');
    const record = worktree.worktree.record;
    expect(loadWorktree(record.id)).toMatchObject({
      creatorSessionId: 'parent-a',
    });

    const attached = attachWorktreeSession(worktree.worktree, 'delegate-token');
    touchWorktreeParentSession(attached.record, 'parent-b');
    const restored = restoreWorktreeSession(attached.record, 'delegate-token');
    touchWorktreeParentSession(restored.record, 'parent-c');
    expect(loadWorktree(record.id)?.recentParentSessionIds).toEqual([
      'parent-b',
      'parent-c',
    ]);

    for (let index = 0; index < 20; index += 1)
      touchWorktreeParentSession(attached.record, `parent-${index}`);
    const bounded = loadWorktree(record.id);
    expect(bounded?.recentParentSessionIds).toHaveLength(16);
    expect(bounded?.creatorSessionId).toBe('parent-a');

    await retireWorktreeSnapshot(record.id);
    await rehydrateWorktreeSession(record, 'delegate-token');
    touchWorktreeParentSession(record, 'parent-refresh');
    expect(loadWorktree(record.id)?.recentParentSessionIds).toContain(
      'parent-refresh',
    );
  });

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

  test('records native checkout arguments before parent WIP carry is applied', async () => {
    const baseHead = git(repository, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'parent WIP\n');
    writeFileSync(
      path.join(repository, 'src', 'parent-only.txt'),
      'parent-only\n',
    );
    configureNativeHooks();
    const worktree = await prepared({ name: 'Hook timing' });
    const child = worktree.record.worktreePath;
    const args = readFileSync(
      path.join(child, '.delegate-setup', 'post-checkout-args'),
      'utf8',
    )
      .trim()
      .split(/\r?\n/);

    expect(args).toHaveLength(3);
    expect(args[0]).toMatch(/^0+$/);
    expect(args[0]).toHaveLength(args[1].length);
    expect(
      readFileSync(path.join(child, '.delegate-setup', 'hook-head'), 'utf8'),
    ).toBe(`${args[1]}\n`);
    expect(args[1]).toBe(baseHead);
    expect(args[2]).toBe('1');
    expect(
      readFileSync(path.join(child, '.delegate-setup', 'hook-value'), 'utf8'),
    ).toBe('one\n');
    expect(
      readFileSync(
        path.join(child, '.delegate-setup', 'parent-only-at-hook'),
        'utf8',
      ),
    ).toBe('absent\n');
    expect(readFileSync(path.join(child, 'src', 'value.txt'), 'utf8')).toBe(
      'parent WIP\n',
    );
    expect(
      readFileSync(path.join(child, 'src', 'parent-only.txt'), 'utf8'),
    ).toBe('parent-only\n');
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

  test('recovers retained resources from a resumed session when the run summary is missing', async () => {
    const writable = await prepared({ name: 'Resumed setup failure' });
    const session = createDelegateSession({
      cwd: repository,
      worktreeId: writable.record.id,
      allowWrites: true,
      isolation: 'worktree',
    });
    try {
      const run = createRun('resumed setup failure', undefined, {
        continuation: session.token,
        context: 'continuation',
        allowWrites: true,
      });
      run.state = 'error';
      setDelegateLifecycle(run, 'setup-failure', 'refresh failed');

      expect(getDelegateLifecycle(run)).toMatchObject({
        reason: 'setup-failure',
        continuationUsable: true,
        writableBranchRetained: true,
        readOnlySnapshotRetained: false,
      });

      await removeWorktree(writable.record.id, { deleteBranch: true });
      expect(getDelegateLifecycle(run)).toMatchObject({
        continuationUsable: false,
        writableBranchRetained: false,
        readOnlySnapshotRetained: false,
      });
    } finally {
      removeDelegateSession(session);
    }
  });

  test('reports a retained read-only diagnostic checkout and not a removed one', async () => {
    const readOnly = await prepared({ name: 'Read-only setup failure' });
    const session = createDelegateSession({
      cwd: repository,
      worktreeId: readOnly.record.id,
      allowWrites: false,
      isolation: 'worktree',
    });
    try {
      const run = createRun('read-only setup failure', undefined, {
        continuation: session.token,
        context: 'continuation',
        allowWrites: false,
      });
      run.state = 'error';
      setDelegateLifecycle(run, 'setup-failure', 'refresh failed');
      expect(getDelegateLifecycle(run)).toMatchObject({
        continuationUsable: true,
        writableBranchRetained: false,
        readOnlySnapshotRetained: true,
      });

      await removeWorktree(readOnly.record.id, { deleteBranch: true });
      expect(getDelegateLifecycle(run)).toMatchObject({
        continuationUsable: false,
        writableBranchRetained: false,
        readOnlySnapshotRetained: false,
      });
    } finally {
      removeDelegateSession(session);
    }
  });

  test.each([
    ['timed-out', 'timed-out', 'timeout'],
    ['aborted', 'aborted', 'user-cancellation'],
    ['error', 'error', 'child-nonzero-exit'],
  ] as const)('preserves the child outcome when finalizing a %s worktree run', async (outcome, state, reason) => {
    const worktree = await prepared();
    const run = createRun('failed attempt', undefined, {
      allowWrites: true,
    });
    run.state = state;
    run.exitCode = state === 'aborted' ? 130 : state === 'timed-out' ? 124 : 7;
    setDelegateLifecycle(run, reason, `child ${reason}`);

    await finalizeWorktreeRun(run, worktree, 'failed attempt');

    expect(getDelegateLifecycle(run)?.reason).toBe(reason);
    expect(getDelegateLifecycle(run)?.reason).not.toBe(
      'lifecycle-cleanup-failure',
    );
    expect(run.worktree?.runOutcome).toBe(outcome);
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
