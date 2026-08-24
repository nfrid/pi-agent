import { describe, expect, test, vi } from 'vitest';
import {
  DelegateJobManager,
  type DelegateJobResult,
  type DelegateJobSnapshot,
  type DelegateJobStartOptions,
} from './jobs';
import { getDelegateLifecycle } from './lifecycle';
import { createRun } from './types';
import {
  type DelegateWorkflowAttemptSnapshot,
  DelegateWorkflowCoordinator,
  WORKFLOW_RELOAD_ORPHAN_REASON,
} from './workflow-coordinator';
import {
  type SymbolicWorkflowSelector,
  WORKFLOW_INPUT_CAPS,
  WORKFLOW_OVERSIZED_EVIDENCE_MARKER,
} from './workflow-inputs';
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
  test('keeps same public IDs independent across immutable branch owners', async () => {
    const manager = new DelegateJobManager();
    const left = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-left',
    });
    const right = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-right',
    });

    const leftAttempt = left.schedule(
      scheduleOptions('impl', async () => result('left')),
    );
    const rightAttempt = right.schedule(
      scheduleOptions('impl', async () => result('right')),
    );

    expect(leftAttempt.identity).toBe('impl@1');
    expect(rightAttempt.identity).toBe('impl@1');
    await settle(left);
    await settle(right);
    expect(left.getResult('impl@1')?.runs[0]?.task).toBe('left');
    expect(right.getResult('impl@1')?.runs[0]?.task).toBe('right');
    expect(left.require('impl@1').ownerBranchId).toBe('branch-left');
    expect(right.require('impl@1').ownerBranchId).toBe('branch-right');
    await left.dispose();
    await right.dispose();
    await manager.dispose();
  });

  test('imports an ancestor attempt before assigning a descendant continuation ordinal', async () => {
    const manager = new DelegateJobManager();
    const ancestor = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-ancestor',
    });
    const descendant = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'branch-descendant',
    });
    const ancestorResult = result('ancestor');
    const ancestorRun = ancestorResult.runs[0];
    if (!ancestorRun) throw new Error('missing ancestor run');
    ancestorRun.continuation = 'ancestor-continuation-token';
    const first = ancestor.schedule(
      scheduleOptions('impl', async () => ancestorResult),
    );
    await settle(ancestor);
    descendant.importFrom(ancestor);

    let inheritedToken: string | undefined;
    const continuation = descendant.schedule({
      logicalId: 'impl',
      continuation: 'impl@1',
      prepare: async (context) => {
        inheritedToken = context.continuationToken;
        return {
          mode: 'single' as const,
          tasks: ['descendant'],
          execute: async () => result('descendant'),
        };
      },
    });
    expect(continuation.identity).toBe('impl@2');
    expect(continuation.dependencies).toEqual(['impl@1']);
    expect(descendant.getResult(first.identity)?.runs[0]?.task).toBe(
      'ancestor',
    );
    await settle(descendant);
    expect(inheritedToken).toBe('ancestor-continuation-token');
    await ancestor.dispose();
    await descendant.dispose();
    await manager.dispose();
  });

  test('persists a hosted process link before the adapter can execute', async () => {
    const manager = new DelegateJobManager();
    const events: string[] = [];
    let coordinator!: DelegateWorkflowCoordinator;
    const processJobId = '123e4567-e89b-42d3-a456-426614174000';
    const execute = vi.fn(async () => {
      events.push('execute');
      return result('hosted');
    });
    coordinator = new DelegateWorkflowCoordinator({
      jobs: manager,
      onChange: () => {
        const metadata = coordinator.metadataSnapshot().attempts[0];
        if (metadata?.state === 'queued')
          events.push(`persist:${metadata.sessionId}:${metadata.processJobId}`);
      },
    });

    coordinator.schedule({
      ...scheduleOptions('hosted', execute),
      sessionId: 'child-session',
      processJobId,
    });

    await settle(coordinator);
    expect(events).toContain(`persist:child-session:${processJobId}`);
    expect(
      events.indexOf(`persist:child-session:${processJobId}`),
    ).toBeLessThan(events.indexOf('execute'));
    await coordinator.dispose();
    await manager.dispose();
  });

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
      inputs: [{ node: 'impl', label: '   ' }],
      prepare,
    });
    expect(child).toMatchObject({
      state: 'scheduled',
      dependencies: ['impl@1'],
      inputs: [{ identity: 'impl@1', selector: { node: 'impl' } }],
    });
    expect(JSON.stringify(child)).not.toContain('done report');
    expect(coordinator.metadataSnapshot().attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: 'child@1',
          inputs: [
            {
              node: 'impl',
              identity: 'impl@1',
            },
          ],
        }),
      ]),
    );
    expect(JSON.stringify(coordinator.metadataSnapshot())).not.toContain(
      'done report',
    );
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
      capabilities: ['web'],
      inputs: [{ node: 'impl', include: ['report'] }],
      prepare: blockedPrepare,
    });
    expect(coordinator.require(blocked.identity).state).toBe('blocked');
    expect(blockedPrepare).not.toHaveBeenCalled();
    const blockedRun = coordinator.getResult(blocked.identity)?.runs[0];
    expect(blockedRun).toMatchObject({ capabilities: ['web'] });
    expect(blockedRun && getDelegateLifecycle(blockedRun)).toMatchObject({
      reason: 'setup-failure',
    });

    const errorPrepare = vi.fn(async () => {
      throw new Error('preparation exploded');
    });
    const errored = coordinator.schedule({
      logicalId: 'errored',
      capabilities: ['web'],
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
    expect(erroredRun).toMatchObject({ capabilities: ['web'] });
    expect(erroredRun && getDelegateLifecycle(erroredRun)).toMatchObject({
      reason: 'setup-failure',
    });
    await manager.dispose();
  });

  test('restores live metadata as terminal reload orphans with evidence', () => {
    const coordinator = new DelegateWorkflowCoordinator({
      now: () => 200,
    });
    coordinator.restoreMetadata(
      {
        version: 1,
        attempts: [
          {
            ownerBranchId: 'branch-restored',
            logicalId: 'upstream',
            attempt: 1,
            identity: 'upstream@1',
            state: 'running',
            dependencies: [],
            waitingFor: [],
            createdAt: 10,
            scheduledAt: 20,
            queuedAt: 30,
            startedAt: 40,
            sessionId: 'child-session-restored',
          },
          {
            ownerBranchId: 'branch-restored',
            logicalId: 'dependent',
            attempt: 1,
            identity: 'dependent@1',
            state: 'scheduled',
            dependencies: ['upstream@1'],
            waitingFor: ['upstream@1'],
            inputs: [
              {
                node: 'upstream',
                identity: 'upstream@1',
                include: ['report'],
              },
            ],
            createdAt: 11,
            scheduledAt: 21,
          },
        ],
      },
      'branch-restored',
    );

    const restored = coordinator.require('dependent@1');
    expect(restored.inputs).toMatchObject([
      {
        identity: 'upstream@1',
        selector: { node: 'upstream', include: ['report'] },
      },
    ]);
    expect(Object.isFrozen(restored.inputs?.[0]?.selector.include)).toBe(true);
    const restoredMetadata = coordinator
      .metadataSnapshot()
      .attempts.find((attempt) => attempt.identity === 'dependent@1');
    expect(Object.isFrozen(restoredMetadata?.inputs?.[0]?.include)).toBe(true);

    expect(coordinator.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: 'upstream@1',
          state: 'blocked',
          reason: WORKFLOW_RELOAD_ORPHAN_REASON,
          createdAt: 10,
          scheduledAt: 20,
          queuedAt: 30,
          startedAt: 40,
          settledAt: 200,
        }),
        expect.objectContaining({
          identity: 'dependent@1',
          state: 'blocked',
          reason: WORKFLOW_RELOAD_ORPHAN_REASON,
          settledAt: 200,
        }),
      ]),
    );
    expect(coordinator.getResult('upstream@1')).toBeDefined();
    expect(coordinator.getResult('dependent@1')).toBeDefined();
    expect(
      coordinator
        .metadataSnapshot()
        .attempts.find((attempt) => attempt.identity === 'upstream@1'),
    ).toMatchObject({ sessionId: 'child-session-restored' });
  });

  test('restores only the current owner and keeps same identities deterministic', async () => {
    const processJobId = '123e4567-e89b-42d3-a456-426614174000';
    const coordinator = new DelegateWorkflowCoordinator({
      ownerBranchId: 'branch-local',
    });
    coordinator.restoreMetadata({
      version: 1,
      attempts: [
        {
          ownerBranchId: 'branch-foreign',
          logicalId: 'shared',
          attempt: 1,
          identity: 'shared@1',
          state: 'running',
          dependencies: [],
          waitingFor: [],
          createdAt: 1,
          scheduledAt: 1,
          queuedAt: 1,
          startedAt: 1,
          sessionId: 'foreign-session',
          processJobId,
        },
        {
          ownerBranchId: 'branch-local',
          logicalId: 'shared',
          attempt: 1,
          identity: 'shared@1',
          state: 'success',
          dependencies: [],
          waitingFor: [],
          createdAt: 2,
          scheduledAt: 2,
          queuedAt: 2,
          startedAt: 2,
          settledAt: 3,
          sessionId: 'local-session',
          processJobId,
        },
      ],
    });

    expect(coordinator.require('shared@1')).toMatchObject({
      ownerBranchId: 'branch-local',
      state: 'success',
      processJobId,
    });
    expect(coordinator.listRestorableHostedLinks()).toEqual([]);
    await expect(coordinator.cancel('foreign@1')).rejects.toThrow();

    const foreignOnly = new DelegateWorkflowCoordinator({
      ownerBranchId: 'branch-local',
    });
    foreignOnly.restoreMetadata({
      version: 1,
      attempts: [
        {
          ownerBranchId: 'branch-foreign',
          logicalId: 'foreign',
          attempt: 1,
          identity: 'foreign@1',
          state: 'running',
          dependencies: [],
          waitingFor: [],
          createdAt: 1,
          scheduledAt: 1,
          queuedAt: 1,
          startedAt: 1,
          sessionId: 'foreign-session',
          processJobId,
        },
      ],
    });
    expect(foreignOnly.list()).toEqual([]);
    expect(foreignOnly.listRestorableHostedLinks()).toEqual([]);
    await expect(foreignOnly.cancel('foreign@1')).rejects.toThrow();
    await coordinator.dispose();
    await foreignOnly.dispose();
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
    let preparationSignal!: AbortSignal;
    const execute = vi.fn(async () => result('must not run'));
    const prepare = vi.fn(
      (context: { signal: AbortSignal }) =>
        new Promise<DelegateJobStartOptions>((resolve) => {
          preparationSignal = context.signal;
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
    expect(preparationSignal.aborted).toBe(true);
    finishPreparation({ mode: 'single', tasks: ['child'], execute });
    await cancellation;
    expect(coordinator.require(child.identity).state).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
    await manager.dispose();
  });

  test('bounds cancellation and discards a late unabortable preparation once', async () => {
    const coordinator = new DelegateWorkflowCoordinator({
      preparationGraceMs: 10,
    });
    let release!: (
      value:
        | DelegateJobStartOptions
        | { launch: DelegateJobStartOptions; discard: () => Promise<void> },
    ) => void;
    const execute = vi.fn(async () => result('must not run'));
    const discard = vi.fn(() => new Promise<void>(() => {}));
    const attempt = coordinator.schedule({
      logicalId: 'bounded-cleanup',
      prepare: () =>
        new Promise<
          | DelegateJobStartOptions
          | { launch: DelegateJobStartOptions; discard: () => Promise<void> }
        >((resolve) => {
          release = resolve;
        }),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const startedAt = Date.now();
    const cancellation = coordinator.cancel(attempt.identity);
    await cancellation;
    expect(Date.now() - startedAt).toBeLessThan(500);
    release({
      launch: { mode: 'single', tasks: ['bounded-cleanup'], execute },
      discard,
    });
    await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
    expect(execute).not.toHaveBeenCalled();
    await coordinator.dispose();
  });

  test('disposal waits for abort-aware preparation discard before clearing records', async () => {
    const coordinator = new DelegateWorkflowCoordinator({
      preparationGraceMs: 100,
    });
    let preparationSignal!: AbortSignal;
    let resourceCreated = false;
    const discard = vi.fn(() => {
      resourceCreated = false;
    });
    const execute = vi.fn(async () => result('must not run'));
    const child = coordinator.schedule({
      logicalId: 'dispose-resource',
      prepare: ({ signal }) =>
        new Promise<{ launch: DelegateJobStartOptions; discard: () => void }>(
          (resolve) => {
            preparationSignal = signal;
            resourceCreated = true;
            signal.addEventListener(
              'abort',
              () =>
                resolve({
                  launch: {
                    mode: 'single',
                    tasks: ['dispose-resource'],
                    execute,
                  },
                  discard,
                }),
              { once: true },
            );
          },
        ),
    });
    await vi.waitFor(() => expect(resourceCreated).toBe(true));

    await coordinator.dispose();

    expect(preparationSignal.aborted).toBe(true);
    expect(discard).toHaveBeenCalledOnce();
    expect(resourceCreated).toBe(false);
    expect(coordinator.list()).toEqual([]);
    expect(child.identity).toBe('dispose-resource@1');
    expect(execute).not.toHaveBeenCalled();
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
      [{ node: 'upstream', label: 'x'.repeat(121) }],
      [{ node: 'upstream' }, { node: 'upstream@1' }],
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

  test('rejects oversized direct and combined dependencies before identity commit', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const execute = async () => result();
    const prepare = async () => ({
      mode: 'single' as const,
      tasks: ['dependency'],
      execute,
    });
    const references: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const attempt = coordinator.schedule({
        logicalId: `dependency-${index}`,
        prepare,
      });
      references.push(attempt.identity);
    }
    expect(() =>
      coordinator.schedule(
        scheduleOptions('direct-overflow', execute, {
          after: references,
        }),
      ),
    ).toThrow(/at most 32 explicit dependencies/);
    expect(coordinator.get('direct-overflow')).toBeUndefined();

    const predecessor = coordinator.schedule({
      logicalId: 'lineage',
      prepare,
    });
    expect(() =>
      coordinator.schedule({
        logicalId: 'lineage',
        continuation: true,
        after: references.slice(0, 32),
        prepare,
      }),
    ).toThrow(/at most 32 combined dependencies/);
    expect(coordinator.get(predecessor.identity)).toBeDefined();
    expect(coordinator.get('lineage@2')).toBeUndefined();
    await coordinator.dispose();
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
    for (let index = 0; index < 32; index++) {
      coordinator.schedule(
        scheduleOptions(`job-${index}`, async () => result(`job-${index}`)),
      );
      if ((index + 1) % 20 === 0)
        await vi.waitFor(() => expect(manager.runningCount).toBe(0));
    }
    await settle(coordinator);
    expect(manager.get('dj-1')).toBeUndefined();
    const retained = coordinator.getResult('first@1');
    expect(retained).toBeDefined();
    expect(retained).not.toBe(firstResult);
    expect(retained?.runs[0]).toMatchObject({
      task: 'first',
      state: 'success',
    });
    expect(JSON.stringify(retained)).not.toContain('child-secret');
    await manager.dispose();
  });

  test('retains bounded canonical evidence without child execution data', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const upstream = coordinator.schedule({
      ...scheduleOptions('evidence', async () => {
        const run = createRun('evidence', undefined, {
          sessionId: 'child-session-secret',
        });
        run.state = 'success';
        run.exitCode = 0;
        run.messages = [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'hidden earlier chatter' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'exact retained report' }],
          },
        ] as never;
        run.stderr = 'hidden stderr';
        run.activities = [
          {
            type: 'tool',
            label: 'hidden activity',
            status: 'completed',
            toolResult: 'hidden activity result',
          },
        ];
        return { runs: [run], handoff: 'exact retained handoff' };
      }),
    });
    await settle(coordinator);
    const evidence = coordinator.getResultEvidence(upstream.identity);
    expect(evidence).toBeDefined();
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(evidence?.reports[0]).toEqual({
      text: 'exact retained report',
      bytes: Buffer.byteLength('exact retained report'),
    });
    expect(evidence?.handoff.text).toBe('exact retained handoff');
    expect(JSON.stringify(evidence)).not.toContain('hidden earlier chatter');
    expect(JSON.stringify(evidence)).not.toContain('hidden stderr');
    expect(JSON.stringify(evidence)).not.toContain('hidden activity');
    expect(JSON.stringify(evidence)).not.toContain('child-session-object');
    const publicResult = coordinator.getResult(upstream.identity);
    expect(JSON.stringify(publicResult)).not.toContain('hidden');
    await coordinator.dispose();
  });

  test('retains an oversized marker without clipping future report evidence', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const oversized = '🙂'.repeat(WORKFLOW_INPUT_CAPS.perItemMaxBytes);
    const upstream = coordinator.schedule(
      scheduleOptions('oversized', async () => {
        const run = createRun('oversized');
        run.state = 'success';
        run.exitCode = 0;
        run.messages = [
          { role: 'assistant', content: [{ type: 'text', text: oversized }] },
        ] as never;
        return { runs: [run], handoff: 'oversized handoff' };
      }),
    );
    await settle(coordinator);
    const evidence = coordinator.getResultEvidence(upstream.identity);
    expect(evidence?.reports[0]).toMatchObject({
      text: WORKFLOW_OVERSIZED_EVIDENCE_MARKER,
      oversized: true,
    });
    expect(evidence?.reports[0]?.text).not.toContain('🙂');
    const dependent = coordinator.schedule({
      logicalId: 'needs-report',
      inputs: [{ node: upstream.identity, include: ['report'] }],
      prepare: async () => ({
        mode: 'single' as const,
        tasks: ['needs-report'],
        execute: async () => result('needs-report'),
      }),
    });
    await vi.waitFor(() =>
      expect(coordinator.require(dependent.identity).state).toBe('blocked'),
    );
    await coordinator.dispose();
  });

  test('rejects schedule before identity at the hard attempt admission bound', () => {
    const coordinator = new DelegateWorkflowCoordinator({ maxAttempts: 1 });
    coordinator.schedule(scheduleOptions('first', async () => result('first')));
    expect(() =>
      coordinator.schedule(
        scheduleOptions('second', async () => result('second')),
      ),
    ).toThrow(/attempt limit of 1/);
    expect(coordinator.list().map(({ identity }) => identity)).toEqual([
      'first@1',
    ]);
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

  test('publishes narrow terminal events exactly once', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const terminal = vi.fn();
    const unsubscribe = coordinator.subscribeTerminal(terminal);
    const attempt = coordinator.schedule(
      scheduleOptions('terminal-event', async () => result('terminal-event')),
    );
    await vi.waitFor(() =>
      expect(coordinator.require(attempt.identity).settledAt).toBeDefined(),
    );
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({ identity: attempt.identity, state: 'success' }),
    );
    unsubscribe();
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
    expect(coordinator.metadataSnapshot().attempts[0]).toMatchObject({
      route: 'provider/model',
    });
    await coordinator.dispose();
  });

  test('logical exact continuation derives its opaque token after settlement', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const firstResult = result('first');
    const firstRun = firstResult.runs[0];
    if (!firstRun) throw new Error('missing first run');
    firstRun.continuation = 'opaque-child-token';
    const first = coordinator.schedule({
      ...scheduleOptions('lineage', async () => firstResult),
      route: 'pinned',
    });
    await vi.waitFor(() =>
      expect(coordinator.require(first.identity).state).toBe('success'),
    );
    let token: string | undefined;
    const second = coordinator.schedule({
      logicalId: 'lineage',
      continuation: 'lineage@1',
      route: 'pinned',
      prepare: async (context) => {
        token = context.continuationToken;
        return {
          mode: 'single' as const,
          tasks: ['second'],
          execute: async () => result('second'),
        };
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require(second.identity).state).toBe('success'),
    );
    expect(token).toBe('opaque-child-token');
    expect(second.identity).toBe('lineage@2');
    expect(second.dependencies).toEqual(['lineage@1']);
    await coordinator.dispose();
  });

  test('uses a restored predecessor session as the continuation token', async () => {
    const coordinator = new DelegateWorkflowCoordinator({
      ownerBranchId: 'branch-reloaded',
    });
    coordinator.restoreMetadata({
      version: 1,
      attempts: [
        {
          ownerBranchId: 'branch-reloaded',
          logicalId: 'lineage',
          attempt: 1,
          identity: 'lineage@1',
          state: 'success',
          dependencies: [],
          waitingFor: [],
          createdAt: 1,
          scheduledAt: 1,
          settledAt: 2,
          sessionId: 'restored-child-session',
        },
      ],
    });
    let token: string | undefined;
    const continuation = coordinator.schedule({
      logicalId: 'lineage',
      continuation: true,
      prepare: async (context) => {
        token = context.continuationToken;
        return {
          mode: 'single' as const,
          tasks: ['continued'],
          execute: async () => result('continued'),
        };
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require(continuation.identity).state).toBe('success'),
    );
    expect(token).toBe('restored-child-session');
    await coordinator.dispose();
  });

  test('blocks a restored continuation with no token or session identity', async () => {
    const coordinator = new DelegateWorkflowCoordinator({
      ownerBranchId: 'branch-blocked',
    });
    coordinator.restoreMetadata({
      version: 1,
      attempts: [
        {
          ownerBranchId: 'branch-blocked',
          logicalId: 'lineage',
          attempt: 1,
          identity: 'lineage@1',
          state: 'success',
          dependencies: [],
          waitingFor: [],
          createdAt: 1,
          scheduledAt: 1,
          settledAt: 2,
        },
      ],
    });
    const prepare = vi.fn(async () => ({
      mode: 'single' as const,
      tasks: ['should-not-launch'],
      execute: async () => result('should-not-launch'),
    }));
    const continuation = coordinator.schedule({
      logicalId: 'lineage',
      continuation: true,
      prepare,
    });
    await vi.waitFor(() =>
      expect(coordinator.require(continuation.identity).state).toBe('blocked'),
    );
    expect(prepare).not.toHaveBeenCalled();
    await coordinator.dispose();
  });

  test('retains continuation tokens through setup failure for the latest attempt', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const firstResult = result('first');
    const firstRun = firstResult.runs[0];
    if (!firstRun) throw new Error('missing first run');
    firstRun.continuation = 'opaque-child-token';
    const first = coordinator.schedule(
      scheduleOptions('impl', async () => firstResult),
    );
    await vi.waitFor(() =>
      expect(coordinator.require(first.identity).state).toBe('success'),
    );
    let failedPreparationToken: string | undefined;
    const second = coordinator.schedule({
      logicalId: 'impl',
      continuation: first.identity,
      prepare: async (context) => {
        failedPreparationToken = context.continuationToken;
        throw new Error('invalid symbolic handoff');
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require(second.identity).state).toBe('error'),
    );
    expect(failedPreparationToken).toBe('opaque-child-token');
    expect(coordinator.getResult(second.identity)?.runs[0]?.continuation).toBe(
      'opaque-child-token',
    );
    expect(
      coordinator.getResultEvidence(second.identity)?.continuationToken,
    ).toBe('opaque-child-token');
    expect(() =>
      coordinator.schedule({
        logicalId: 'impl',
        continuation: first.identity,
        prepare: async () => ({
          mode: 'single' as const,
          tasks: ['stale'],
          execute: async () => result('stale'),
        }),
      }),
    ).toThrow();

    let thirdToken: string | undefined;
    const third = coordinator.schedule({
      logicalId: 'impl',
      name: 'Third implementation',
      continuation: true,
      prepare: async (context) => {
        thirdToken = context.continuationToken;
        return {
          mode: 'single' as const,
          tasks: ['third'],
          execute: async () => result('third'),
        };
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require(third.identity).state).toBe('success'),
    );
    expect(third.identity).toBe('impl@3');
    expect(thirdToken).toBe('opaque-child-token');
    expect(
      coordinator
        .metadataSnapshot()
        .attempts.find((attempt) => attempt.identity === third.identity)?.name,
    ).toBe('Third implementation');

    const fresh = coordinator.schedule({
      logicalId: 'fresh',
      prepare: async () => {
        throw new Error('fresh setup failure');
      },
    });
    await vi.waitFor(() =>
      expect(coordinator.require(fresh.identity).state).toBe('error'),
    );
    expect(coordinator.getResult(fresh.identity)?.runs[0]?.continuation).toBe(
      undefined,
    );
    expect(
      coordinator.getResultEvidence(fresh.identity)?.continuationToken,
    ).toBe(undefined);
    await coordinator.dispose();
  });

  test('discards one lazy preparation exactly once when cancellation wins', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    let release!: (launch: DelegateJobStartOptions) => void;
    const discard = vi.fn();
    const execute = vi.fn(async () => result('must not run'));
    const attempt = coordinator.schedule({
      logicalId: 'cleanup',
      prepare: () =>
        new Promise<
          | DelegateJobStartOptions
          | { launch: DelegateJobStartOptions; discard: () => void }
        >((resolve) => {
          release = (launch) => resolve({ launch, discard });
        }),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const cancelled = coordinator.cancel(attempt.identity);
    release({ mode: 'single', tasks: ['cleanup'], execute });
    await cancelled;
    await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
    expect(execute).not.toHaveBeenCalled();
    await coordinator.dispose();
  });

  test('does not cancel or settle imported ancestor attempts', async () => {
    const manager = new DelegateJobManager();
    const ancestor = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'ancestor-branch',
    });
    const descendant = new DelegateWorkflowCoordinator({
      ownerBranchId: 'descendant-branch',
    });
    let finish!: (value: DelegateJobResult) => void;
    const attempt = ancestor.schedule(
      scheduleOptions(
        'ancestor-work',
        () =>
          new Promise<DelegateJobResult>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    descendant.importFrom(ancestor);
    await descendant.cancel(attempt.identity);
    expect(ancestor.require(attempt.identity).state).toBe('running');
    await descendant.dispose();
    expect(ancestor.require(attempt.identity).state).toBe('running');
    finish(result('ancestor-work'));
    await settle(ancestor);
    await ancestor.dispose();
    await manager.dispose();
  });

  test('imports later ancestor attempts during reconciliation in lineage order', async () => {
    const manager = new DelegateJobManager();
    const ancestor = new DelegateWorkflowCoordinator({
      jobs: manager,
      ownerBranchId: 'ancestor-lineage',
    });
    const descendant = new DelegateWorkflowCoordinator({
      ownerBranchId: 'descendant-lineage',
    });
    let finish!: (value: DelegateJobResult) => void;
    const first = ancestor.schedule(
      scheduleOptions(
        'lineage',
        () =>
          new Promise<DelegateJobResult>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    descendant.importFrom(ancestor);
    const second = ancestor.schedule(
      scheduleOptions('lineage', async () => result('second'), {
        continuation: first.identity,
      }),
    );
    expect(descendant.get(second.identity)).toBeDefined();
    finish(result('first'));
    await settle(ancestor);
    await vi.waitFor(() =>
      expect(descendant.require(second.identity).state).toBe('success'),
    );
    await descendant.dispose();
    await ancestor.dispose();
    await manager.dispose();
  });

  test('clears lazy closures after a synchronous terminal settlement', async () => {
    const manager = new DelegateJobManager();
    const synchronous = result('synchronous');
    vi.spyOn(manager, 'start').mockImplementation((options) => {
      const snapshot = {
        id: 'dj-sync',
        name: options.name ?? 'Subagent',
        mode: options.mode,
        state: 'success',
        tasks: [...options.tasks],
        createdAt: Date.now(),
        settledAt: Date.now(),
      } satisfies DelegateJobSnapshot;
      options.onTerminal?.(synchronous, snapshot);
      return snapshot;
    });
    const coordinator = new DelegateWorkflowCoordinator({ jobs: manager });
    const prepare = vi.fn(async () => ({
      mode: 'single' as const,
      tasks: ['synchronous'],
      execute: async () => result('must not replace synchronous settlement'),
    }));
    const attempt = coordinator.schedule({
      logicalId: 'synchronous',
      prepare,
    });
    await vi.waitFor(() =>
      expect(coordinator.require(attempt.identity).state).toBe('success'),
    );
    const records = (
      coordinator as unknown as {
        records: Map<string, { prepare?: unknown; launch?: unknown }>;
      }
    ).records;
    expect(records.get(attempt.identity)).toMatchObject({
      prepare: undefined,
      launch: undefined,
    });
    await coordinator.dispose();
    await manager.dispose();
  });
});
