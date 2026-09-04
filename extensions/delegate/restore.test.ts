import { readFileSync, rmSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { DelegateJobManager, type DelegateJobResult } from './jobs';
import {
  RestoreBindingConflictError,
  type RestoreSessionError,
  reconcileRestoredHostedAttempts,
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
  capabilities?: ['web'],
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
        ...(capabilities ? { capabilities } : {}),
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

function session(
  worktreeId?: string,
  capabilities?: ['web'],
  skills?: string[],
) {
  return createDelegateSession({
    cwd: '/tmp/restored-delegate',
    name: 'Persisted delegate',
    parentSessionId: PARENT,
    ...(worktreeId ? { worktreeId, isolation: 'worktree' as const } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(skills ? { skills } : {}),
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

  test('reopened control channels accept feedback while observation is active', async () => {
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
    let release!: () => void;
    const restored = restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        runDelegate: () =>
          new Promise<DelegatedRun>((resolve) => {
            release = () => resolve(finishedRun('restore'));
          }),
      },
    });
    await vi.waitFor(() => expect(manager.runningCount).toBe(1));

    expect(
      manager.sendFeedback(restored.job.id, 'Use the corrected result.'),
    ).toMatchObject({ delivery: 'queued' });
    expect(
      readFileSync(restored.control.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({
        kind: 'feedback',
        message: 'Use the corrected result.',
      }),
    ]);

    release();
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').state).toBe('success'),
    );
    await cleanup();
  });

  test('duplicate restore claims do not start an orphan observer or terminal callback', async () => {
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
    let release!: () => void;
    const execute = vi.fn(
      () =>
        new Promise<DelegatedRun>((resolve) => {
          release = () => resolve(finishedRun('restore'));
        }),
    );
    const terminal = vi.fn();
    coordinator.subscribeTerminal(terminal);
    const first = restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: { runDelegate: execute as never },
    });

    expect(() =>
      restoreHostedDelegateAttempt({
        parentSessionId: PARENT,
        attempt: 'restore@1',
        manager,
        coordinator,
        dependencies: { runDelegate: execute as never },
      }),
    ).toThrowError(RestoreBindingConflictError);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(manager.runningCount).toBe(1);
    release();
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').state).toBe('success'),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledOnce();
    expect(manager.get(first.job.id)).toMatchObject({ state: 'success' });
    await cleanup();
  });

  test('cancellation during finalize returns one canonical aborted result', async () => {
    const child = session('cancel-finalize-worktree');
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
    let releaseFinalize!: () => void;
    const finalize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFinalize = resolve;
        }),
    );
    const materialize = vi.fn(async (runs: DelegatedRun[]) => ({
      runs,
      handoff: 'should not publish',
    }));
    const updates: DelegatedRun[] = [];
    restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      stopExistingHost: async () => undefined,
      dependencies: {
        loadWorktree: () => record,
        restoreWorktreeSession: () => prepared,
        finalizeWorktreeRun: finalize,
        runDelegate: async () => finishedRun('restore'),
        materialize,
        onRunUpdate: (run) => updates.push(run),
      },
    });
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());
    const cancellation = coordinator.cancel('restore@1');
    releaseFinalize();
    await cancellation;
    expect(coordinator.require('restore@1').state).toBe('cancelled');
    expect(materialize).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ state: 'aborted', exitCode: 130 });
    await cleanup();
  });

  test('detach during finalize does not publish or settle the workflow', async () => {
    const child = session('detach-finalize-worktree');
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
    let releaseFinalize!: () => void;
    const finalize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFinalize = resolve;
        }),
    );
    const materialize = vi.fn(async (runs: DelegatedRun[]) => ({
      runs,
      handoff: 'should not publish',
    }));
    const updates: DelegatedRun[] = [];
    const restored = restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        loadWorktree: () => record,
        restoreWorktreeSession: () => prepared,
        finalizeWorktreeRun: finalize,
        runDelegate: async () => finishedRun('restore'),
        materialize,
        onRunUpdate: (run) => updates.push(run),
      },
    });
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());
    const detaching = manager.detach([restored.job.id]);
    releaseFinalize();
    await detaching;
    expect(coordinator.require('restore@1').state).toBe('running');
    expect(materialize).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    await cleanup();
  });

  test('cancellation during materialization cannot settle observation success', async () => {
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
    let releaseMaterialize!: (result: DelegateJobResult) => void;
    const materialize = vi.fn(
      (runs: DelegatedRun[]) =>
        new Promise<DelegateJobResult>((resolve) => {
          releaseMaterialize = (result) => resolve(result);
          void runs;
        }),
    );
    const updates: DelegatedRun[] = [];
    const restored = restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      stopExistingHost: async () => undefined,
      dependencies: {
        runDelegate: async () => finishedRun('restore'),
        materialize,
        onRunUpdate: (run) => updates.push(run),
      },
    });
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledOnce());
    const cancellation = coordinator.cancel('restore@1');
    releaseMaterialize({ runs: [finishedRun('restore')], handoff: 'success' });
    await cancellation;
    expect(coordinator.require('restore@1').state).toBe('cancelled');
    expect(updates.at(-1)).toMatchObject({ state: 'aborted', exitCode: 130 });
    expect(manager.get(restored.job.id)).toMatchObject({ state: 'aborted' });
    await cleanup();
  });

  test('detach during materialization leaves workflow active without publishing terminal state', async () => {
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
    let releaseMaterialize!: (result: DelegateJobResult) => void;
    const materialize = vi.fn(
      (runs: DelegatedRun[]) =>
        new Promise<DelegateJobResult>((resolve) => {
          releaseMaterialize = (result) => resolve(result);
          void runs;
        }),
    );
    const updates: DelegatedRun[] = [];
    const restored = restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        runDelegate: async () => finishedRun('restore'),
        materialize,
        onRunUpdate: (run) => updates.push(run),
      },
    });
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledOnce());
    const detaching = manager.detach([restored.job.id]);
    releaseMaterialize({ runs: [finishedRun('restore')], handoff: 'success' });
    await detaching;
    expect(coordinator.require('restore@1').state).toBe('running');
    expect(updates).toHaveLength(0);
    await cleanup();
  });

  test('materialization failure updates status with canonical failed run before workflow error', async () => {
    const child = session(undefined, ['web']);
    sessions.push(child);
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-restore',
    });
    managers.push(manager);
    coordinators.push(coordinator);
    coordinator.restoreMetadata(
      metadata(child.token, 'running', 'restore', ['web']),
    );
    const updates: DelegatedRun[] = [];
    restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        runDelegate: async () => finishedRun('restore'),
        materialize: async () => {
          throw new Error('output file publication failed');
        },
        onRunUpdate: (run) => updates.push(run),
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').state).toBe('error'),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      state: 'error',
      workflowAttempt: { identity: 'restore@1' },
      errorMessage: expect.stringContaining('output file publication failed'),
      capabilities: ['web'],
    });
    expect(coordinator.getResult('restore@1')?.runs[0]).toMatchObject({
      state: 'error',
      capabilities: ['web'],
    });
    await cleanup();
  });

  test('passes exact persisted absolute skills to a hosted restore observer', async () => {
    const skills = [
      '/tmp/restored-delegate/skills/review.md',
      '/tmp/restored-delegate/skills/testing',
    ];
    const child = session(undefined, undefined, skills);
    sessions.push(child);
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-restore',
    });
    managers.push(manager);
    coordinators.push(coordinator);
    coordinator.restoreMetadata(metadata(child.token));
    const capturedSkills: string[][] = [];
    const runDelegate = vi.fn(async (options: { skills?: string[] }) => {
      capturedSkills.push(options.skills ?? []);
      return finishedRun('restore');
    });

    restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: { runDelegate: runDelegate as never },
    });
    await vi.waitFor(() => expect(capturedSkills).toHaveLength(1));
    expect(capturedSkills[0]).toEqual(skills);
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
    const runDelegate = vi.fn(async () => finishedRun('restore'));
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
    expect(runDelegate).toHaveBeenCalledTimes(1);
    expect(coordinator.getResult('restore@1')?.runs[0]?.runId).toBe(
      PROCESS_JOB_ID,
    );
    expect(coordinator.get('restore@1')?.reason).toContain('missing worktree');
    await cleanup();
  });

  test('reconcile settles a missing session as bounded blocked state and releases dependants once', async () => {
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
    removeDelegateSession(child);
    reconcileRestoredHostedAttempts({
      parentSessionId: PARENT,
      manager,
      coordinator,
    });
    expect(coordinator.require('restore@1').state).toBe('blocked');
    expect(coordinator.require('restore@1').reason).toContain('missing');
    await vi.waitFor(() => expect(dependentRuns).toBe(1));
    reconcileRestoredHostedAttempts({
      parentSessionId: PARENT,
      manager,
      coordinator,
    });
    expect(dependentRuns).toBe(1);
    await cleanup();
  });

  test('valid worktree restoration uses finalization and output-file materialization seams', async () => {
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
      handoff: 'file-backed handoff',
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

  test('retries beyond the old finite limit with the same control and process run ID', async () => {
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
    let calls = 0;
    let firstControl: unknown;
    restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        runDelegate: async (options) => {
          expect(options.runId).toBe(PROCESS_JOB_ID);
          expect(options.processJobId).toBe(PROCESS_JOB_ID);
          calls++;
          firstControl ??= options.control;
          expect(options.control).toBe(firstControl);
          const run = finishedRun('restore', calls <= 6 ? 'error' : 'success');
          run.runId = PROCESS_JOB_ID;
          if (calls <= 6) run.retryable = true;
          return run;
        },
        waitForRetry: async () => 'retry',
      },
    });
    expect(
      reconcileRestoredHostedAttempts({
        parentSessionId: PARENT,
        manager,
        coordinator,
      }),
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').state).toBe('success'),
    );
    expect(calls).toBe(7);
    expect(coordinator.getResult('restore@1')?.runs[0]?.runId).toBe(
      PROCESS_JOB_ID,
    );
    await cleanup();
  });

  test('detach during retry backoff stops observation without settling the workflow', async () => {
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
    let calls = 0;
    const restored = restoreHostedDelegateAttempt({
      parentSessionId: PARENT,
      attempt: 'restore@1',
      manager,
      coordinator,
      dependencies: {
        runDelegate: async () => {
          calls++;
          const run = finishedRun('restore', 'error');
          run.retryable = true;
          run.runId = PROCESS_JOB_ID;
          return run;
        },
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require('restore@1').jobId).toBeDefined(),
    );
    await manager.detach([restored.job.id]);
    expect(calls).toBe(1);
    expect(coordinator.require('restore@1').state).toBe('running');
    await cleanup();
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
