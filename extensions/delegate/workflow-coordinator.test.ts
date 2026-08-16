import { describe, expect, test, vi } from 'vitest';
import { DelegateJobManager, type DelegateJobResult } from './jobs';
import { createRun } from './types';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';
import {
  assertWorkflowAttemptTransition,
  canTransitionWorkflowAttemptState,
} from './workflow-model';

function result(
  task = 'work',
  state: 'success' | 'error' | 'timed-out' | 'aborted' = 'success',
): DelegateJobResult {
  const run = createRun(task);
  run.state = state;
  run.exitCode = state === 'success' ? 0 : 1;
  run.finishedAt = Date.now();
  return { runs: [run], handoff: `${state}: ${task}` };
}

function scheduleOptions(
  logicalId: string,
  execute: (signal: AbortSignal) => Promise<DelegateJobResult>,
  extra: Partial<Parameters<DelegateWorkflowCoordinator['schedule']>[0]> = {},
) {
  return {
    logicalId,
    mode: 'single' as const,
    tasks: [logicalId],
    execute,
    ...extra,
  };
}

async function settle(coordinator: DelegateWorkflowCoordinator): Promise<void> {
  await vi.waitFor(() =>
    expect(
      coordinator.list().every((attempt) => attempt.settledAt !== undefined),
    ).toBe(true),
  );
}

describe('DelegateWorkflowCoordinator', () => {
  test('launches a fresh attempt immediately without dependencies', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const execute = vi.fn(async () => result());

    const attempt = coordinator.schedule(scheduleOptions('impl', execute));

    expect(attempt).toMatchObject({
      identity: 'impl@1',
      dependencies: [],
      state: 'running',
      jobId: 'dj-1',
    });
    await settle(coordinator);
    expect(execute).toHaveBeenCalledOnce();
    expect(coordinator.require('impl@1').state).toBe('success');
    await manager.dispose();
  });

  test('waits for a running upstream and launches a dependent once', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    let finish!: (value: DelegateJobResult) => void;
    const upstream = coordinator.schedule(
      scheduleOptions(
        'upstream',
        () => new Promise<DelegateJobResult>((resolve) => (finish = resolve)),
      ),
    );
    const dependentExecute = vi.fn(async () => result('dependent'));
    const dependent = coordinator.schedule(
      scheduleOptions('dependent', dependentExecute, { after: ['upstream'] }),
    );

    expect(upstream.state).toBe('running');
    expect(dependent).toMatchObject({
      state: 'scheduled',
      dependencies: ['upstream@1'],
    });
    expect(dependentExecute).not.toHaveBeenCalled();
    finish(result('upstream'));
    await settle(coordinator);
    expect(dependentExecute).toHaveBeenCalledOnce();
    expect(coordinator.require('dependent').state).toBe('success');
    await manager.dispose();
  });

  test.each([
    ['error', 'error'],
    ['aborted', 'aborted'],
    ['timed-out', 'timed-out'],
  ] as const)('releases readiness on %s upstream settlement', async (runState, expectedState) => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const dependentExecute = vi.fn(async () => result('dependent'));
    const upstream = coordinator.schedule(
      scheduleOptions('upstream', async () => result('upstream', runState)),
    );
    coordinator.schedule(
      scheduleOptions('dependent', dependentExecute, {
        after: [upstream.identity],
      }),
    );

    await settle(coordinator);
    expect(coordinator.require(upstream.identity).state).toBe(expectedState);
    expect(dependentExecute).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  test('continuation implicitly waits for its predecessor and exact after stays bound', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    let finish!: (value: DelegateJobResult) => void;
    const first = coordinator.schedule(
      scheduleOptions(
        'impl',
        () => new Promise<DelegateJobResult>((resolve) => (finish = resolve)),
      ),
    );
    const reviewExecute = vi.fn(async () => result('review'));
    coordinator.schedule(
      scheduleOptions('review', reviewExecute, { after: ['impl@1'] }),
    );
    const second = coordinator.schedule(
      scheduleOptions('impl', async () => result('second'), {
        continuation: true,
      }),
    );

    expect(second).toMatchObject({
      identity: 'impl@2',
      dependencies: ['impl@1'],
      state: 'scheduled',
    });
    finish(result('first'));
    await settle(coordinator);
    expect(reviewExecute).toHaveBeenCalledOnce();
    expect(coordinator.require('review').dependencies).toEqual(['impl@1']);
    await manager.dispose();
    expect(first.identity).toBe('impl@1');
  });

  test('rejects malformed, unknown, duplicate references without partial mutation', () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const execute = async () => result();
    expect(() =>
      coordinator.schedule(
        scheduleOptions('child', execute, { after: ['missing'] }),
      ),
    ).toThrow(/Unknown logical ID/);
    expect(coordinator.list()).toEqual([]);

    coordinator.schedule(scheduleOptions('upstream', execute));
    expect(() =>
      coordinator.schedule(
        scheduleOptions('child', execute, {
          after: ['upstream', 'upstream@1'],
        }),
      ),
    ).toThrow(/Duplicate workflow dependency/);
    expect(() =>
      coordinator.schedule(
        scheduleOptions('child', execute, { after: ['bad reference'] }),
      ),
    ).toThrow(/Invalid workflow reference/);
    expect(coordinator.list().map(({ identity }) => identity)).toEqual([
      'upstream@1',
    ]);
  });

  test('scheduled cancellation never launches and releases downstream readiness', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    let finish!: (value: DelegateJobResult) => void;
    const upstream = coordinator.schedule(
      scheduleOptions(
        'upstream',
        () => new Promise<DelegateJobResult>((resolve) => (finish = resolve)),
      ),
    );
    const downstreamExecute = vi.fn(async () => result('downstream'));
    const downstream = coordinator.schedule(
      scheduleOptions('downstream', downstreamExecute, {
        after: [upstream.identity],
      }),
    );
    const waiting = coordinator.schedule(
      scheduleOptions('waiting', async () => result('waiting'), {
        after: [downstream.identity],
      }),
    );

    await coordinator.cancel(downstream.identity);
    expect(coordinator.require(downstream.identity).state).toBe('cancelled');
    expect(downstreamExecute).not.toHaveBeenCalled();
    finish(result('upstream'));
    await settle(coordinator);
    expect(coordinator.require(waiting.identity).state).toBe('success');
    await manager.dispose();
  });

  test('launch exceptions settle as bounded errors and release dependants', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const upstream = coordinator.schedule(
      scheduleOptions('upstream', async () => {
        throw new Error(`launch diagnostic ${'x'.repeat(1_000)}`);
      }),
    );
    const dependentExecute = vi.fn(async () => result('dependent'));
    coordinator.schedule(
      scheduleOptions('dependent', dependentExecute, {
        after: [upstream.identity],
      }),
    );

    await settle(coordinator);
    const failed = coordinator.require(upstream.identity);
    expect(failed.state).toBe('error');
    expect(failed.reason).toContain('launch diagnostic');
    expect(failed.reason?.length).toBeLessThanOrEqual(256);
    expect(dependentExecute).toHaveBeenCalledOnce();
    await coordinator.dispose();
  });

  test('waiting peek cannot suppress coordinator settlement', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    let finish!: (value: DelegateJobResult) => void;
    const upstream = coordinator.schedule(
      scheduleOptions(
        'upstream',
        () => new Promise<DelegateJobResult>((resolve) => (finish = resolve)),
      ),
    );
    const dependentExecute = vi.fn(async () => result('dependent'));
    coordinator.schedule(
      scheduleOptions('dependent', dependentExecute, {
        after: [upstream.identity],
      }),
    );
    const waitingPeek = manager.peek(upstream.jobId ?? '', 1_000);
    finish(result('upstream'));
    await waitingPeek;
    await settle(coordinator);
    expect(dependentExecute).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  test('retains canonical exact results after adapter snapshots are pruned', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const firstResult = result('first');
    coordinator.schedule(scheduleOptions('first', async () => firstResult));
    await vi.waitFor(() => expect(manager.runningCount).toBe(0));
    for (let index = 0; index < 40; index++) {
      coordinator.schedule(
        scheduleOptions(`job-${index}`, async () => result(`job-${index}`)),
      );
      await vi.waitFor(() => expect(manager.runningCount).toBe(0));
    }
    await settle(coordinator);
    expect(manager.get('dj-1')).toBeUndefined();
    expect(coordinator.getResult('first@1')).toBe(firstResult);
    await manager.dispose();
  });

  test('snapshots are detached and lifecycle transitions are enforced', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const original = coordinator.schedule(
      scheduleOptions('impl', async () => result()),
    );
    const snapshot = coordinator.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.attempts)).toBe(true);
    expect(Object.isFrozen(snapshot.attempts[0])).toBe(true);
    expect(Object.isFrozen(snapshot.attempts[0]?.dependencies)).toBe(true);
    expect(() => {
      (snapshot.attempts[0] as { state: string }).state = 'error';
    }).toThrow();
    await settle(coordinator);
    expect(coordinator.require(original.identity).state).toBe('success');
    expect(canTransitionWorkflowAttemptState('success', 'running')).toBe(false);
    expect(() => assertWorkflowAttemptTransition('success', 'running')).toThrow(
      /Illegal workflow attempt transition/,
    );
    await coordinator.dispose();
  });

  test('keeps route and internal job identity in snapshots', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const attempt = coordinator.schedule(
      scheduleOptions('routed', async () => result(), {
        route: 'provider/model',
      }),
    );
    expect(attempt.route).toBe('provider/model');
    expect(attempt.jobId).toBe('dj-1');
    await coordinator.dispose();
  });
});
