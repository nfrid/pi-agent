import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { SqliteOrchestrationRepository } from './sqlite-orchestration-repository.js';

async function database(): Promise<{
  db: DatabaseSync;
  repository: SqliteOrchestrationRepository;
  file: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-orchestration-'));
  const file = path.join(root, 'dashboard.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return { db, repository: new SqliteOrchestrationRepository(db), file };
}

async function fixture() {
  const value = await database();
  const project = value.repository.createProject({
    id: 'project-1',
    title: 'Dashboard',
    rootPath: '/repo',
    repositoryIdentity: '/repo/.git',
    maxParallelRuns: 2,
  });
  const checkout = value.repository.createCheckout({
    id: 'checkout-1',
    projectId: project.id,
    kind: 'worktree',
    path: '/repo/.worktrees/one',
    branch: 'pi/one',
    status: 'ready',
  });
  return { ...value, project, checkout };
}

describe('SqliteOrchestrationRepository', () => {
  it('round-trips durable entities and preserves the complete prompt after reopen', async () => {
    const value = await fixture();
    const prompt = 'Keep every character, including trailing spaces.  ';
    const thread = value.repository.createThread({
      id: 'thread-1',
      projectId: value.project.id,
      title: 'First task',
      checkoutId: value.checkout.id,
      pinnedAt: 123,
    });
    const run = value.repository.createRun({
      id: 'run-1',
      threadId: thread.id,
      initialPrompt: prompt,
      model: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
    });
    expect(value.repository.getProject(value.project.id)).toEqual(
      value.project,
    );
    expect(
      value.repository.updateThread(thread.id, { title: 'Renamed' }).title,
    ).toBe('Renamed');
    expect(
      value.repository.transitionCheckout(value.checkout.id, 'dirty').status,
    ).toBe('dirty');
    expect(value.repository.getRun(run.id)?.initialPrompt).toBe(prompt);
    value.repository.setRunError(run.id, 'stale ACK failure');
    expect(value.repository.clearRunError(run.id).error).toBeUndefined();
    expect(value.repository.getThread(thread.id)?.pinnedAt).toBe(123);
    expect(value.repository.threadSummaries()[0]?.pinnedAt).toBe(123);
    const disposable = value.repository.createProject({
      id: 'project-disposable',
      title: 'Disposable',
      rootPath: '/disposable',
    });
    expect(
      value.repository.updateProject(disposable.id, { title: 'Updated' }).title,
    ).toBe('Updated');
    value.repository.deleteProject(disposable.id);
    expect(value.repository.getProject(disposable.id)).toBeUndefined();
    value.db.close();

    const reopened = new DatabaseSync(value.file);
    try {
      runMigrations(reopened);
      expect(
        new SqliteOrchestrationRepository(reopened).getRun(run.id)
          ?.initialPrompt,
      ).toBe(prompt);
    } finally {
      reopened.close();
    }
  });

  it('returns one result for repeated idempotent create commands', async () => {
    const value = await fixture();
    const result = value.repository.createThreadWithRun('command-1', {
      thread: {
        id: 'thread-idempotent',
        projectId: value.project.id,
        title: 'Once',
        checkoutId: value.checkout.id,
      },
      run: { id: 'run-idempotent', initialPrompt: 'Do it.' },
    });
    const repeated = value.repository.createThreadWithRun('command-1', {
      thread: {
        id: 'different-thread',
        projectId: value.project.id,
        title: 'Must not be inserted',
        checkoutId: value.checkout.id,
      },
      run: { id: 'different-run', initialPrompt: 'Must not be inserted.' },
    });
    expect(repeated.thread).toEqual(result.thread);
    expect(repeated.run).toEqual(result.run);
    expect(value.repository.listThreads()).toHaveLength(1);
    expect(value.repository.getCommandReceipt('command-1')).toBeDefined();
    expect(() =>
      value.repository.createRunIdempotent('command-1', {
        threadId: 'thread-idempotent',
        initialPrompt: 'Wrong command.',
        mode: 'read',
      }),
    ).toThrow('belongs to thread.create');

    const runThread = value.repository.createThread({
      id: 'thread-run-command',
      projectId: value.project.id,
      title: 'Run command',
      checkoutId: value.checkout.id,
    });
    value.repository.createRunIdempotent('run-command-1', {
      threadId: runThread.id,
      initialPrompt: 'Run once.',
      mode: 'read',
    });
    expect(() =>
      value.repository.createThreadWithRun('run-command-1', {
        thread: {
          projectId: value.project.id,
          title: 'Wrong command',
          checkoutId: value.checkout.id,
        },
        run: { initialPrompt: 'Must not be cast.' },
      }),
    ).toThrow('belongs to run.create');
  });

  it('atomically allocates one isolated checkout for a replayed command', async () => {
    const value = await fixture();
    const result = value.repository.createIsolatedThreadWithRun(
      'isolated-once',
      {
        checkout: {
          id: 'isolated-checkout',
          kind: 'worktree',
          path: '/repo/.worktrees/isolated',
          status: 'preparing',
        },
        thread: {
          id: 'isolated-thread',
          projectId: value.project.id,
          title: 'Isolated',
        },
        run: { id: 'isolated-run', initialPrompt: 'Do it.' },
      },
    );
    const replay = value.repository.createIsolatedThreadWithRun(
      'isolated-once',
      {
        checkout: {
          id: 'orphan-checkout',
          kind: 'worktree',
          path: '/repo/.worktrees/orphan',
        },
        thread: {
          id: 'orphan-thread',
          projectId: value.project.id,
          title: 'Must not exist',
        },
        run: { id: 'orphan-run', initialPrompt: 'Must not exist.' },
      },
    );
    expect(replay).toEqual(result);
    expect(value.repository.listCheckouts(value.project.id)).toHaveLength(2);
    expect(value.repository.listThreads(value.project.id)).toHaveLength(1);
    expect(value.repository.listRuns()).toHaveLength(1);
    expect(
      value.repository.listCheckouts(value.project.id).map((item) => item.id),
    ).toContain('isolated-checkout');
  });

  it('keeps a second isolated run queued until the project parallel slot settles', async () => {
    const value = await fixture();
    value.repository.updateProject(value.project.id, { maxParallelRuns: 1 });
    const secondCheckout = value.repository.createCheckout({
      id: 'checkout-parallel-2',
      projectId: value.project.id,
      kind: 'worktree',
      path: '/repo/.worktrees/parallel-two',
      branch: 'pi/parallel-two',
      status: 'ready',
    });
    const firstThread = value.repository.createThread({
      id: 'thread-parallel-1',
      projectId: value.project.id,
      title: 'First',
      checkoutId: value.checkout.id,
    });
    const secondThread = value.repository.createThread({
      id: 'thread-parallel-2',
      projectId: value.project.id,
      title: 'Second',
      checkoutId: secondCheckout.id,
    });
    const first = value.repository.createRun({
      id: 'run-parallel-1',
      threadId: firstThread.id,
      initialPrompt: 'First',
    });
    const second = value.repository.createRun({
      id: 'run-parallel-2',
      threadId: secondThread.id,
      initialPrompt: 'Second',
    });
    expect(value.repository.claimQueuedRun(first.id)?.status).toBe('preparing');
    expect(value.repository.claimQueuedRun(second.id)).toBeUndefined();
    value.repository.transitionRun(first.id, 'starting');
    value.repository.transitionRun(first.id, 'running');
    value.repository.transitionRun(first.id, 'settled');
    expect(value.repository.claimQueuedRun(second.id)?.status).toBe(
      'preparing',
    );
  });

  it('enforces legal transitions and rejects illegal transitions', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-transition',
      projectId: value.project.id,
      title: 'Transitions',
      checkoutId: value.checkout.id,
    });
    const run = value.repository.createRun({
      id: 'run-transition',
      threadId: thread.id,
      initialPrompt: 'Transition.',
    });
    expect(value.repository.transitionRun(run.id, 'preparing').status).toBe(
      'preparing',
    );
    expect(value.repository.transitionRun(run.id, 'starting').status).toBe(
      'starting',
    );
    expect(value.repository.transitionRun(run.id, 'running').status).toBe(
      'running',
    );
    expect(() => value.repository.transitionRun(run.id, 'queued')).toThrow(
      'Illegal run transition',
    );
    expect(value.repository.transitionRun(run.id, 'settled').status).toBe(
      'settled',
    );
    expect(() => value.repository.transitionRun(run.id, 'failed')).toThrow(
      'Illegal run transition',
    );
  });

  it('enforces active thread, writer checkout, runtime session, and worktree uniqueness', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-unique',
      projectId: value.project.id,
      title: 'Unique',
      checkoutId: value.checkout.id,
    });
    value.repository.createRun({
      id: 'run-unique-1',
      threadId: thread.id,
      initialPrompt: 'One',
    });
    expect(() =>
      value.repository.createRun({
        id: 'run-unique-2',
        threadId: thread.id,
        initialPrompt: 'Two',
      }),
    ).toThrow();

    const secondCheckout = value.repository.createCheckout({
      id: 'checkout-2',
      projectId: value.project.id,
      kind: 'worktree',
      path: '/repo/.worktrees/two',
      branch: 'pi/two',
      status: 'ready',
    });
    const secondThread = value.repository.createThread({
      id: 'thread-unique-2',
      projectId: value.project.id,
      title: 'Unique two',
      checkoutId: secondCheckout.id,
    });
    expect(() =>
      value.repository.createRun({
        id: 'run-unique-writer',
        threadId: secondThread.id,
        initialPrompt: 'Writer',
      }),
    ).not.toThrow();
    const checkoutConflictThread = value.repository.createThread({
      id: 'thread-writer-conflict',
      projectId: value.project.id,
      title: 'Writer conflict',
      checkoutId: value.checkout.id,
    });
    expect(() =>
      value.repository.createRun({
        id: 'run-unique-writer-2',
        threadId: checkoutConflictThread.id,
        initialPrompt: 'Writer conflict',
      }),
    ).toThrowError(expect.objectContaining({ code: 'active-writer' }));
    expect(() =>
      value.repository.createCheckout({
        id: 'checkout-duplicate-path',
        projectId: value.project.id,
        kind: 'worktree',
        path: value.checkout.path,
        branch: 'pi/three',
      }),
    ).toThrow();
    expect(() =>
      value.repository.createCheckout({
        id: 'checkout-duplicate-branch',
        projectId: value.project.id,
        kind: 'worktree',
        path: '/repo/.worktrees/three',
        branch: value.checkout.branch,
      }),
    ).toThrow();

    expect(() =>
      value.repository.bindRuntime({
        runtimeId: 'runtime-missing-run',
        piSessionId: 'pi-session-missing-run',
        runId: 'missing-run',
      }),
    ).toThrow('does not exist');
    value.repository.bindRuntime({
      runtimeId: 'runtime-1',
      piSessionId: 'pi-session-1',
      runId: 'run-unique-1',
    });
    expect(() =>
      value.repository.bindRuntime({
        runtimeId: 'runtime-2',
        piSessionId: 'pi-session-1',
        runId: 'run-unique-writer',
      }),
    ).toThrow();
    value.repository.stopRuntime('runtime-1');
    expect(() =>
      value.repository.bindRuntime({
        runtimeId: 'runtime-2',
        piSessionId: 'pi-session-1',
        runId: 'run-unique-writer',
      }),
    ).not.toThrow();
    value.repository.bindRuntime({
      runtimeId: 'runtime-3',
      piSessionId: 'pi-session-3',
      runId: 'run-unique-1',
    });
    expect(() =>
      value.repository.bindRuntime({
        runtimeId: 'runtime-4',
        piSessionId: 'pi-session-4',
        runId: 'run-unique-1',
      }),
    ).toThrow();
  });

  it('claims checkout merge ownership with a cross-connection CAS', async () => {
    const value = await fixture();
    const secondDb = new DatabaseSync(value.file);
    secondDb.exec('PRAGMA foreign_keys=ON');
    const second = new SqliteOrchestrationRepository(secondDb);
    try {
      expect(
        value.repository.claimCheckoutForMerge(value.checkout.id)?.status,
      ).toBe('merging');
      expect(second.claimCheckoutForMerge(value.checkout.id)).toBeUndefined();
      expect(value.repository.getCheckout(value.checkout.id)?.status).toBe(
        'merging',
      );
      value.repository.transitionCheckout(value.checkout.id, 'dirty');
      expect(second.claimCheckoutForMerge(value.checkout.id)?.status).toBe(
        'merging',
      );
    } finally {
      secondDb.close();
    }
  });

  it('queues a retry atomically and preserves that projection across replay and reopen', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-queued-retry',
      projectId: value.project.id,
      title: 'Queued retry',
      checkoutId: value.checkout.id,
      status: 'settled',
    });
    const first = value.repository.createRunIdempotent('retry-command', {
      threadId: thread.id,
      initialPrompt: 'Retry me.',
    });
    const queued = value.repository.getThread(thread.id);
    expect(first.status).toBe('queued');
    expect(queued?.status).toBe('queued');
    const updatedAt = queued?.updatedAt;
    const replay = value.repository.createRunIdempotent('retry-command', {
      threadId: thread.id,
      initialPrompt: 'Must not create a second retry.',
    });
    expect(replay).toEqual(first);
    expect(value.repository.getThread(thread.id)?.updatedAt).toBe(updatedAt);
    value.db.close();

    const reopened = new DatabaseSync(value.file);
    try {
      runMigrations(reopened);
      expect(
        new SqliteOrchestrationRepository(reopened).getThread(thread.id)
          ?.status,
      ).toBe('queued');
    } finally {
      reopened.close();
    }
  });

  it('atomically retries one terminal run on its existing checkout', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-atomic-retry',
      projectId: value.project.id,
      title: 'Atomic retry',
      checkoutId: value.checkout.id,
    });
    const first = value.repository.createRun({
      id: 'run-atomic-retry-1',
      threadId: thread.id,
      initialPrompt: 'Original prompt',
    });
    value.repository.transitionRun(first.id, 'preparing');
    value.repository.transitionRun(first.id, 'starting');
    value.repository.transitionRun(first.id, 'running');
    value.repository.transitionRun(first.id, 'settled');

    const result = value.repository.retryRunIdempotent('atomic-retry', {
      threadId: thread.id,
      initialPrompt: 'Continue the work.',
    });
    expect(result.run.checkoutId).toBe(first.checkoutId);
    expect(result.run.parentRunId).toBe(first.id);
    expect(result.run.attempt).toBe(2);
    expect(result.thread.checkoutId).toBe(first.checkoutId);
    expect(result.thread.status).toBe('queued');
    expect(value.repository.listCheckouts(value.project.id)).toHaveLength(1);

    const replay = value.repository.retryRunIdempotent('atomic-retry', {
      threadId: thread.id,
      initialPrompt: 'A different prompt must not be used.',
    });
    expect(replay).toEqual(result);
    expect(value.repository.listRuns(thread.id)).toHaveLength(2);
    expect(() =>
      value.repository.createRunIdempotent('atomic-retry', {
        threadId: thread.id,
        initialPrompt: 'Wrong command type.',
      }),
    ).toThrow('belongs to run.retry');
    value.repository.transitionRun(result.run.id, 'preparing');
    value.repository.transitionRun(result.run.id, 'starting');
    value.repository.transitionRun(result.run.id, 'running');
    value.repository.transitionRun(result.run.id, 'settled');
    value.repository.transitionCheckout(value.checkout.id, 'retired');
    expect(() =>
      value.repository.retryRunIdempotent('retired-retry', {
        threadId: thread.id,
        initialPrompt: 'Must not run.',
      }),
    ).toThrowError(expect.objectContaining({ code: 'orchestration-conflict' }));
    expect(value.repository.listRuns(thread.id)).toHaveLength(2);
    value.db.close();

    const reopened = new DatabaseSync(value.file);
    try {
      runMigrations(reopened);
      const reopenedRepository = new SqliteOrchestrationRepository(reopened);
      expect(
        reopenedRepository.getCommandReceipt('atomic-retry')?.result,
      ).toEqual({ run: result.run, thread: result.thread });
      expect(reopenedRepository.getRun(result.run.id)?.checkoutId).toBe(
        first.checkoutId,
      );
    } finally {
      reopened.close();
    }
  });

  it('rejects retry while the latest run is not terminal', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      projectId: value.project.id,
      title: 'Active retry',
      checkoutId: value.checkout.id,
    });
    value.repository.createRun({
      threadId: thread.id,
      initialPrompt: 'Still running.',
    });
    expect(() =>
      value.repository.retryRunIdempotent('active-retry', {
        threadId: thread.id,
        initialPrompt: 'No.',
      }),
    ).toThrow('Only a terminal run can be retried.');
  });

  it('records retry attempt lineage after the first run settles', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-lineage',
      projectId: value.project.id,
      title: 'Lineage',
      checkoutId: value.checkout.id,
    });
    const first = value.repository.createRun({
      id: 'run-lineage-1',
      threadId: thread.id,
      initialPrompt: 'Original prompt',
    });
    value.repository.transitionRun(first.id, 'preparing');
    value.repository.transitionRun(first.id, 'starting');
    value.repository.transitionRun(first.id, 'running');
    value.repository.transitionRun(first.id, 'settled');
    expect(() =>
      value.repository.createRun({
        id: 'run-lineage-bad-attempt',
        threadId: thread.id,
        attempt: 3,
        initialPrompt: 'Bad attempt.',
      }),
    ).toThrow('continue immediately from 2');
    expect(() =>
      value.repository.createRun({
        id: 'run-lineage-bad-parent',
        threadId: thread.id,
        parentRunId: 'missing-parent',
        initialPrompt: 'Bad parent.',
      }),
    ).toThrow('does not exist');
    const otherThread = value.repository.createThread({
      id: 'thread-other-lineage',
      projectId: value.project.id,
      title: 'Other lineage',
      checkoutId: value.checkout.id,
    });
    const otherRun = value.repository.createRun({
      id: 'run-other-lineage',
      threadId: otherThread.id,
      initialPrompt: 'Other prompt.',
      mode: 'read',
    });
    expect(() =>
      value.repository.createRun({
        id: 'run-lineage-cross-thread',
        threadId: thread.id,
        parentRunId: otherRun.id,
        initialPrompt: 'Cross-thread parent.',
      }),
    ).toThrow('same thread');
    const retry = value.repository.createRun({
      id: 'run-lineage-2',
      threadId: thread.id,
      initialPrompt: 'Retry prompt',
    });
    expect(retry.attempt).toBe(2);
    expect(retry.parentRunId).toBe(first.id);
    value.repository.transitionRun(retry.id, 'preparing');
    value.repository.transitionRun(retry.id, 'starting');
    value.repository.transitionRun(retry.id, 'running');
    value.repository.transitionRun(retry.id, 'settled');
    expect(() =>
      value.repository.createRun({
        id: 'run-lineage-non-immediate-parent',
        threadId: thread.id,
        parentRunId: first.id,
        initialPrompt: 'Non-immediate parent.',
      }),
    ).toThrow('immediately preceding');
  });
});
