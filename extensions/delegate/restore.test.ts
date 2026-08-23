import { rmSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { DelegateJobManager, type DelegateJobResult } from './jobs';
import {
  type RestoreSessionError,
  resolveTrustedDelegateSession,
  restoreHostedDelegateAttempt,
} from './restore';
import {
  createDelegateSession,
  removeDelegateSession,
  resolveDelegateSession,
} from './session';
import { createRun, type DelegatedRun } from './types';
import {
  DelegateWorkflowCoordinator,
  type DelegateWorkflowMetadataHistory,
} from './workflow-coordinator';
import type { PreparedWorktree, WorktreeRecord } from './worktree';

const PROCESS_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const PARENT = 'restore-parent';

function metadata(
  sessionId: string,
  state: 'queued' | 'running' = 'running',
  logicalId = 'restore',
): DelegateWorkflowMetadataHistory {
  const now = Date.now();
  return {
    version: 1,
    attempts: [
      {
        ownerBranchId: 'branch-restore',
        logicalId,
        attempt: 1,
        identity: `${logicalId}@1`,
        state,
        dependencies: [],
        waitingFor: [],
        createdAt: now,
        scheduledAt: now,
        ...(state === 'queued'
          ? { queuedAt: now }
          : { queuedAt: now, startedAt: now }),
        sessionId,
        processJobId: PROCESS_JOB_ID,
      },
    ],
  };
}

function finishedRun(task: string, state: DelegatedRun['state'] = 'success') {
  const run = createRun(task, undefined, {
    sessionId: 'restored-child',
    allowWrites: false,
    isolation: 'shared',
  });
  run.state = state;
  run.exitCode = state === 'success' ? 0 : 1;
  run.finishedAt = Date.now();
  return run;
}

function result(
  task: string,
  state: DelegatedRun['state'] = 'success',
): DelegateJobResult {
  const run = finishedRun(task, state);
  return { runs: [run], handoff: `Outcome: ${state}` };
}

function session(worktreeId?: string) {
  return createDelegateSession({
    cwd: '/tmp/restored-delegate',
    name: 'Persisted delegate',
    parentSessionId: PARENT,
    ...(worktreeId ? { worktreeId, isolation: 'worktree' as const } : {}),
  });
}

describe('restored delegate adapter', () => {
  const sessions: ReturnType<typeof session>[] = [];
  const managers: DelegateJobManager[] = [];
  const coordinators: DelegateWorkflowCoordinator[] = [];

  async function cleanup() {
    for (const coordinator of coordinators.splice(0))
      await coordinator.dispose();
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const item of sessions.splice(0)) {
      const resolved = resolveDelegateSession(item.token);
      if (resolved) removeDelegateSession(resolved);
      else rmSync(item.filePath, { force: true });
    }
  }

  test('enumerates and idempotently binds one local link without a fresh launch', async () => {
    const child = session();
    sessions.push(child);
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-restore',
    });
    managers.push(manager);
    coordinators.push(coordinator);
    coordinator.restoreMetadata(metadata(child.token));
    expect(coordinator.listRestorableHostedLinks()).toMatchObject([
      {
        identity: 'restore@1',
        sessionId: child.token,
        processJobId: PROCESS_JOB_ID,
      },
    ]);
    const execute = vi.fn(async () => result('restored'));
    const job = manager.observeExisting({
      name: 'Persisted delegate',
      ownerBranchId: 'branch-restore',
      mode: 'single',
      tasks: ['restore@1'],
      workflowAttempt: coordinator.require('restore@1').attempt,
      execute,
      onTerminal: (value, snapshot) =>
        coordinator.acceptRestoredHostedTerminal('restore@1', snapshot, value),
    });
    const bound = coordinator.bindRestoredHostedJob('restore@1', job);
    expect(coordinator.bindRestoredHostedJob('restore@1', job)).toMatchObject({
      jobId: job.id,
    });
    expect(bound.jobId).toBe(job.id);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').state).toBe('success'),
    );
    expect(coordinator.listRestorableHostedLinks()).toEqual([]);
    await cleanup();
  });

  test('reopens control, observes read-only completion, and releases a dependent once', async () => {
    const child = session();
    sessions.push(child);
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-restore',
    });
    managers.push(manager);
    coordinators.push(coordinator);
    coordinator.restoreMetadata(metadata(child.token));
    let dependentRuns = 0;
    coordinator.schedule({
      logicalId: 'dependent',
      after: ['restore@1'],
      mode: 'single',
      tasks: ['dependent'],
      execute: async () => {
        dependentRuns++;
        return result('dependent');
      },
    });
    const restored = restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        runDelegate: async (options) => {
          expect(options.observeExisting).toBe(true);
          expect(options.hosted).toBe(true);
          expect(options.allowWrites).toBe(false);
          expect(options.task).toBe('restore@1');
          return result('restore').runs[0] as never;
        },
      },
    });
    expect(restored.control.filePath).toContain(PROCESS_JOB_ID);
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').state).toBe('success'),
    );
    await vi.waitFor(() => expect(dependentRuns).toBe(1));
    expect(coordinator.require('dependent').state).toBe('success');
    await cleanup();
  });

  test('invalid worktree binding settles conservatively and retains the resource', async () => {
    const child = session('missing-worktree');
    sessions.push(child);
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-restore',
    });
    managers.push(manager);
    coordinators.push(coordinator);
    coordinator.restoreMetadata(metadata(child.token));
    const runDelegate = vi.fn();
    restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: { runDelegate: runDelegate as never },
    });
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').state).toBe('error'),
    );
    expect(runDelegate).not.toHaveBeenCalled();
    expect(coordinator.get('restore@1')?.reason).toContain('missing worktree');
    await cleanup();
  });

  test('valid worktree restoration uses finalization and artifact materialization seams', async () => {
    const child = session('valid-worktree');
    sessions.push(child);
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-restore',
    });
    managers.push(manager);
    coordinators.push(coordinator);
    coordinator.restoreMetadata(metadata(child.token));
    const record = {
      id: '11111111-1111-1111-1111-111111111111',
      repositoryRoot: '/tmp/repository',
      worktreePath: '/tmp/worktree',
      branch: 'delegate/restore',
      workingDirectory: '',
    } as WorktreeRecord;
    const prepared = {
      record,
      env: { PI_DELEGATE_WORKTREE: record.id },
    } as PreparedWorktree;
    const finalize = vi.fn(async () => undefined);
    const materialize = vi.fn(async (runs: DelegatedRun[]) => ({
      runs,
      handoff: 'artifact-backed handoff',
    }));
    restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        loadWorktree: () => record,
        restoreWorktreeSession: () => prepared,
        finalizeWorktreeRun: finalize,
        runDelegate: async (options) => {
          expect(options.worktree).toBe(prepared);
          return finishedRun('restore');
        },
        materialize,
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').state).toBe('success'),
    );
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledTimes(1);
    await cleanup();
  });

  test('rejects missing and foreign sessions before creating an observation', () => {
    const child = session();
    sessions.push(child);
    expect(() =>
      resolveTrustedDelegateSession(child.token, 'other-parent'),
    ).toThrowError(
      expect.objectContaining<Partial<RestoreSessionError>>({
        code: 'foreign-session',
      }),
    );
    removeDelegateSession(child);
    expect(() =>
      resolveTrustedDelegateSession(child.token, PARENT),
    ).toThrowError(
      expect.objectContaining<Partial<RestoreSessionError>>({
        code: 'missing-session',
      }),
    );
  });

  test('host restart settles as an error without relaunch', async () => {
    const child = session();
    sessions.push(child);
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-restore',
    });
    managers.push(manager);
    coordinators.push(coordinator);
    coordinator.restoreMetadata(metadata(child.token));
    restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        runDelegate: async () => {
          const run = finishedRun('restore', 'error');
          run.errorMessage = 'process host restarted; job was not adopted';
          return run;
        },
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').state).toBe('error'),
    );
    expect(coordinator.require('restore@1').reason).toContain('host restarted');
    await cleanup();
  });

  test('detach leaves the restored workflow active and retains the control channel', async () => {
    const child = session();
    sessions.push(child);
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-restore',
    });
    managers.push(manager);
    coordinators.push(coordinator);
    coordinator.restoreMetadata(metadata(child.token));
    const restored = restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        runDelegate: async (options) =>
          new Promise<DelegatedRun>((resolve) =>
            options.detachSignal?.addEventListener(
              'abort',
              () => {
                options.control?.detach();
                resolve(finishedRun('restore', 'aborted'));
              },
              { once: true },
            ),
          ),
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').jobId).toBeDefined(),
    );
    await manager.detach([restored.job.id]);
    expect(coordinator.require('restore@1').state).toBe('running');
    expect(restored.control.filePath).toContain(PROCESS_JOB_ID);
    await cleanup();
  });

  test('explicit cancellation settles the restored workflow without relaunch', async () => {
    const child = session();
    sessions.push(child);
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-restore',
    });
    managers.push(manager);
    coordinators.push(coordinator);
    coordinator.restoreMetadata(metadata(child.token));
    restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        runDelegate: async (options) =>
          new Promise<DelegatedRun>((resolve) =>
            options.signal?.addEventListener(
              'abort',
              () => resolve(finishedRun('restore', 'aborted')),
              { once: true },
            ),
          ),
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').jobId).toBeDefined(),
    );
    await coordinator.cancel('restore@1');
    expect(coordinator.require('restore@1').state).toBe('cancelled');
    await cleanup();
  });
});
