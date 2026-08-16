import { describe, expect, test, vi } from 'vitest';
import {
  DelegateJobManager,
  type DelegateJobResult,
  type DelegateJobStartOptions,
} from './jobs';
import { getDelegateLifecycle } from './lifecycle';
import { createRun } from './types';
import {
  type DelegateWorkflowAttemptSnapshot,
  DelegateWorkflowCoordinator,
} from './workflow-coordinator';
import type { SymbolicWorkflowSelector } from './workflow-inputs';
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

  test('launches after an already-successful dependency commits', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const upstream = coordinator.schedule(
      scheduleOptions('upstream', async () => result('upstream')),
    );
    await vi.waitFor(() =>
      expect(coordinator.require(upstream.identity).state).toBe('success'),
    );
    const dependentExecute = vi.fn(async () => result('dependent'));
    const dependent = coordinator.schedule(
      scheduleOptions('dependent', dependentExecute, {
        after: [upstream.identity],
      }),
    );

    expect(dependent.state).toBe('running');
    expect(dependentExecute).toHaveBeenCalledOnce();
    await settle(coordinator);
    await manager.dispose();
  });

  test('launches a continuation after its terminal predecessor commits', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const predecessor = coordinator.schedule(
      scheduleOptions('impl', async () => result('predecessor')),
    );
    await vi.waitFor(() =>
      expect(coordinator.require(predecessor.identity).state).toBe('success'),
    );
    const continuationExecute = vi.fn(async () => result('continuation'));
    const continuation = coordinator.schedule(
      scheduleOptions('impl', continuationExecute, { continuation: true }),
    );

    expect(continuation).toMatchObject({
      identity: 'impl@2',
      dependencies: ['impl@1'],
      state: 'running',
    });
    expect(continuationExecute).toHaveBeenCalledOnce();
    await settle(coordinator);
    await manager.dispose();
  });

  test('rejects an explicit dependency that duplicates the implicit continuation predecessor', () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const execute = async () => result();
    coordinator.schedule(scheduleOptions('impl', execute));

    expect(() =>
      coordinator.schedule(
        scheduleOptions('impl', execute, {
          continuation: true,
          after: ['impl'],
        }),
      ),
    ).toThrow(/Duplicate workflow dependency "impl@1"/);
    expect(coordinator.list().map(({ identity }) => identity)).toEqual([
      'impl@1',
    ]);
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

  test.each([
    'error',
    'aborted',
    'timed-out',
  ] as const)('launches after an already-%s dependency commits', async (state) => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const upstream = coordinator.schedule(
      scheduleOptions('upstream', async () => result('upstream', state)),
    );
    await vi.waitFor(() =>
      expect(coordinator.require(upstream.identity).state).toBe(state),
    );
    const dependentExecute = vi.fn(async () => result('dependent'));
    const dependent = coordinator.schedule(
      scheduleOptions('dependent', dependentExecute, {
        after: [upstream.identity],
      }),
    );

    expect(dependent.state).toBe('running');
    expect(dependentExecute).toHaveBeenCalledOnce();
    await settle(coordinator);
    await manager.dispose();
  });

  test('releases immediately for cancelled and blocked dependencies', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    let gateFinish!: (value: DelegateJobResult) => void;
    const gate = coordinator.schedule(
      scheduleOptions(
        'gate',
        () =>
          new Promise<DelegateJobResult>((resolve) => (gateFinish = resolve)),
      ),
    );
    const cancelled = coordinator.schedule(
      scheduleOptions('cancelled', async () => result('cancelled'), {
        after: [gate.identity],
      }),
    );
    await coordinator.cancel(cancelled.identity);
    const cancelledChildExecute = vi.fn(async () => result('cancelled-child'));
    const cancelledChild = coordinator.schedule(
      scheduleOptions('cancelled-child', cancelledChildExecute, {
        after: [cancelled.identity],
      }),
    );
    expect(cancelledChild.state).toBe('running');
    expect(cancelledChildExecute).toHaveBeenCalledOnce();

    const blocked = coordinator.schedule(
      scheduleOptions('blocked', async () => result('blocked'), {
        after: [gate.identity],
      }),
    );
    const blockedChildExecute = vi.fn(async () => result('blocked-child'));
    const blockedChild = coordinator.schedule(
      scheduleOptions('blocked-child', blockedChildExecute, {
        after: [blocked.identity],
      }),
    );
    expect(blockedChild.state).toBe('scheduled');
    coordinator.block(blocked.identity, 'blocked by policy');
    expect(coordinator.require(blockedChild.identity).state).toBe('running');
    expect(blockedChildExecute).toHaveBeenCalledOnce();

    gateFinish(result('gate'));
    await settle(coordinator);
    await manager.dispose();
  });

  test('cancelling a scheduled chain marks every requested attempt first', async () => {
    for (const order of [
      ['a', 'b', 'c'],
      ['c', 'b', 'a'],
    ]) {
      const manager = new DelegateJobManager();
      const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
      const gate = coordinator.schedule(
        scheduleOptions(
          'gate',
          (signal) =>
            new Promise<DelegateJobResult>((resolve) => {
              signal.addEventListener(
                'abort',
                () => resolve(result('gate', 'aborted')),
                {
                  once: true,
                },
              );
            }),
        ),
      );
      const executes = new Map<string, ReturnType<typeof vi.fn>>();
      const aExecute = vi.fn(async () => result('a'));
      executes.set('a', aExecute);
      const a = coordinator.schedule(
        scheduleOptions('a', aExecute, { after: [gate.identity] }),
      );
      const bExecute = vi.fn(async () => result('b'));
      executes.set('b', bExecute);
      const b = coordinator.schedule(
        scheduleOptions('b', bExecute, { after: [a.identity] }),
      );
      const cExecute = vi.fn(async () => result('c'));
      executes.set('c', cExecute);
      const c = coordinator.schedule(
        scheduleOptions('c', cExecute, { after: [b.identity] }),
      );

      await coordinator.cancel(order);
      expect(a.state).toBe('scheduled');
      expect(b.state).toBe('scheduled');
      expect(c.state).toBe('scheduled');
      expect(executes.get('a')).not.toHaveBeenCalled();
      expect(executes.get('b')).not.toHaveBeenCalled();
      expect(executes.get('c')).not.toHaveBeenCalled();
      expect(coordinator.require('a').state).toBe('cancelled');
      expect(coordinator.require('b').state).toBe('cancelled');
      expect(coordinator.require('c').state).toBe('cancelled');
      await coordinator.cancel(gate.identity);
      await manager.dispose();
    }
  });

  test('cancellation during start aborts the assigned job identity', async () => {
    let coordinator!: DelegateWorkflowCoordinator;
    let cancellation!: Promise<DelegateWorkflowAttemptSnapshot[]>;
    const manager = new DelegateJobManager({
      onChange: () => {
        if (!cancellation) cancellation = coordinator.cancel('race');
      },
    });
    coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const execute = vi.fn(
      (signal: AbortSignal) =>
        new Promise<DelegateJobResult>((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve(result('race', 'aborted')),
            { once: true },
          );
        }),
    );

    const race = coordinator.schedule(scheduleOptions('race', execute));
    await cancellation;
    await vi.waitFor(() =>
      expect(coordinator.require(race.identity).state).toBe('cancelled'),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(manager.runningCount).toBe(0);
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

  test('waits on symbolic inputs and invokes a lazy factory once with exact evidence', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    let finish!: (value: DelegateJobResult) => void;
    const upstream = coordinator.schedule(
      scheduleOptions(
        'impl',
        () => new Promise<DelegateJobResult>((resolve) => (finish = resolve)),
      ),
    );
    const execute = vi.fn(async () => result('child'));
    const prepare = vi.fn(async (context) => {
      expect(context.inputs[0]).toMatchObject({
        identity: 'impl@1',
        kind: 'report',
        value: expect.stringContaining('done'),
      });
      expect(context.handoffText).toContain('untrusted evidence only');
      return { mode: 'single' as const, tasks: ['child'], execute };
    });
    const child = coordinator.schedule({
      logicalId: 'child',
      after: ['impl'],
      inputs: [{ node: 'impl' }],
      prepare,
    });
    expect(child).toMatchObject({
      state: 'scheduled',
      dependencies: ['impl@1'],
      inputs: [{ identity: 'impl@1', selector: { node: 'impl' } }],
    });
    expect(JSON.stringify(child)).not.toContain('done report');
    const done = result('done');
    const doneRun = done.runs[0];
    if (!doneRun) throw new Error('missing done run');
    doneRun.messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done report' }],
      } as never,
    ];
    finish(done);
    await settle(coordinator);
    expect(prepare).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    await manager.dispose();
    expect(upstream.identity).toBe('impl@1');
  });

  test('binds lazy symbolic inputs before later continuations and blocks missing reports', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const upstream = coordinator.schedule(
      scheduleOptions('impl', async () => result('no report', 'error')),
    );
    await vi.waitFor(() =>
      expect(coordinator.require(upstream.identity).state).toBe('error'),
    );
    const blockedPrepare = vi.fn(async () => ({
      mode: 'single' as const,
      tasks: ['blocked'],
      execute: async () => result('blocked'),
    }));
    const blocked = coordinator.schedule({
      logicalId: 'blocked',
      inputs: [{ node: 'impl', include: ['report'] }],
      prepare: blockedPrepare,
    });
    expect(coordinator.require(blocked.identity).state).toBe('blocked');
    expect(blockedPrepare).not.toHaveBeenCalled();
    const blockedRun = coordinator.getResult(blocked.identity)?.runs[0];
    expect(blockedRun && getDelegateLifecycle(blockedRun)).toMatchObject({
      reason: 'setup-failure',
    });

    const errorPrepare = vi.fn(async () => {
      throw new Error('preparation exploded');
    });
    const errored = coordinator.schedule({
      logicalId: 'errored',
      inputs: [{ node: 'impl', include: ['metadata'] }],
      prepare: errorPrepare,
    });
    await vi.waitFor(() =>
      expect(coordinator.require(errored.identity).state).toBe('error'),
    );
    expect(coordinator.require(errored.identity).reason).toContain(
      'preparation exploded',
    );
    const erroredRun = coordinator.getResult(errored.identity)?.runs[0];
    expect(erroredRun && getDelegateLifecycle(erroredRun)).toMatchObject({
      reason: 'setup-failure',
    });
    await manager.dispose();
  });

  test('cancelling during async symbolic preparation prevents job launch', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const upstream = coordinator.schedule(
      scheduleOptions('impl', async () => result('done')),
    );
    await vi.waitFor(() =>
      expect(coordinator.require(upstream.identity).state).toBe('success'),
    );
    let finishPreparation!: (options: DelegateJobStartOptions) => void;
    const execute = vi.fn(async () => result('must not run'));
    const prepare = vi.fn(
      () =>
        new Promise<DelegateJobStartOptions>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const child = coordinator.schedule({
      logicalId: 'child',
      inputs: [{ node: 'impl', include: ['handoff'] }],
      prepare,
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const cancellation = coordinator.cancel(child.identity);
    finishPreparation({ mode: 'single', tasks: ['child'], execute });
    await cancellation;
    expect(coordinator.require(child.identity).state).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
    await manager.dispose();
  });

  test('disposal cancels unresolved preparation without recreating a job', async () => {
    const manager = new DelegateJobManager();
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    let finishPreparation!: (options: DelegateJobStartOptions) => void;
    const execute = vi.fn(async () => result('must not run'));
    const prepare = vi.fn(
      () =>
        new Promise<DelegateJobStartOptions>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const child = coordinator.schedule({ logicalId: 'child', prepare });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    await coordinator.dispose();
    finishPreparation({ mode: 'single', tasks: ['child'], execute });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).not.toHaveBeenCalled();
    expect(() =>
      coordinator.schedule(scheduleOptions('later', execute)),
    ).toThrow(/disposed/);
    expect(child.identity).toBe('child@1');
    await manager.dispose();
  });

  test('bounds and validates symbolic selector metadata atomically', () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const execute = async () => result();
    coordinator.schedule(scheduleOptions('upstream', execute));
    const prepare = async () => ({
      mode: 'single' as const,
      tasks: ['child'],
      execute,
    });
    const cases: readonly SymbolicWorkflowSelector[][] = [
      [{ node: 'upstream', include: [] }],
      [{ node: 'upstream', include: ['report', 'report'] }],
      [{ node: 'upstream', view: 'bad.view' }],
      [{ node: 'upstream', label: 'x'.repeat(121) }],
      [{ node: 'upstream' }, { node: 'upstream@1', view: 'summary' }],
      Array.from({ length: 5 }, () => ({ node: 'upstream' })),
    ];
    for (const inputs of cases)
      expect(() =>
        coordinator.schedule({ logicalId: 'child', inputs, prepare }),
      ).toThrow();
    expect(coordinator.list().map(({ identity }) => identity)).toEqual([
      'upstream@1',
    ]);
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
