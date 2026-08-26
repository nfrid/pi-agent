import { describe, expect, test, vi } from 'vitest';
import { DelegateJobManager, type DelegateJobResult } from './jobs';
import { createRun } from './types';
import {
  cloneAndFreezeWakeJson,
  WAKE_MAX_SUBSCRIPTIONS,
  WakeCoordinator,
  type WakeDispatch,
} from './wake-coordinator';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';

function result(
  task: string,
  state: 'success' | 'error' = 'success',
): DelegateJobResult {
  const run = createRun(task);
  run.state = state;
  run.exitCode = state === 'success' ? 0 : 1;
  run.finishedAt = Date.now();
  run.outputFile = {
    path: `/tmp/pi/files/${task}.md`,
    size: Buffer.byteLength(task),
  };
  return {
    runs: [run],
    handoff: `Status: ${state}\nOutcome: ${task} complete`,
  };
}

function options(logicalId: string, execute: () => Promise<DelegateJobResult>) {
  return {
    logicalId,
    mode: 'single' as const,
    tasks: [logicalId],
    execute,
  };
}

async function settled(
  workflow: DelegateWorkflowCoordinator,
  identity: string,
): Promise<void> {
  await vi.waitFor(() =>
    expect(workflow.require(identity).settledAt).toBeDefined(),
  );
}

describe('WakeCoordinator', () => {
  test('binds exact attempts and handles an already-settled registration', async () => {
    const workflow = new DelegateWorkflowCoordinator({
      jobs: new DelegateJobManager(),
    });
    workflow.schedule(options('build', async () => result('first')));
    await settled(workflow, 'build@1');
    const wake = new WakeCoordinator({ workflow });

    const registered = wake.register({
      id: 'review-ready',
      condition: { node: 'build' },
      payload: ['handoff', 'metadata'],
    });
    expect(registered).toMatchObject({
      state: 'ready',
      references: ['build@1'],
      payload: [{ kind: 'handoff' }, { kind: 'metadata' }],
    });

    workflow.schedule({
      ...options('build', async () => result('second')),
      continuation: true,
    });
    expect(wake.require('review-ready').references).toEqual(['build@1']);
    await workflow.dispose();
  });

  test('settlement during registration is one-shot', async () => {
    let finish!: (value: DelegateJobResult) => void;
    const workflow = new DelegateWorkflowCoordinator({
      jobs: new DelegateJobManager(),
    });
    const first = workflow.schedule(
      options(
        'build',
        () => new Promise<DelegateJobResult>((resolve) => (finish = resolve)),
      ),
    );
    const entered = vi.fn();
    const wake = new WakeCoordinator({
      workflow,
      dispatch: (dispatch) => {
        entered(dispatch);
        wake.markEntered(dispatch.wake.id, dispatch.acknowledgement);
      },
    });
    const registered = wake.register({
      id: 'one-shot',
      condition: { node: first.identity },
    });
    expect(registered.state).toBe('pending');
    finish(result('build'));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    expect(wake.require('one-shot').state).toBe('entered');
    finish(result('build-again'));
    await Promise.resolve();
    expect(entered).toHaveBeenCalledOnce();
    await workflow.dispose();
  });

  test.each([
    ['all', { all: ['a', 'b'] }],
    ['any', { any: ['a', 'b'] }],
  ] as const)('supports %s terminal barriers including failures', async (_name, condition) => {
    const workflow = new DelegateWorkflowCoordinator({
      jobs: new DelegateJobManager(),
    });
    const a = workflow.schedule(options('a', async () => result('a')));
    const b = workflow.schedule(options('b', async () => result('b', 'error')));
    await settled(workflow, a.identity);
    await settled(workflow, b.identity);
    const dispatch = vi.fn();
    const wake = new WakeCoordinator({ workflow, dispatch });
    const registered = wake.register({ id: `${_name}-wake`, condition });
    if ('all' in condition) {
      expect(registered.state).toBe('queued');
      expect(dispatch).toHaveBeenCalledOnce();
    } else {
      expect(registered.state).toBe('queued');
      expect(dispatch).toHaveBeenCalledOnce();
    }
    expect(wake.require(registered.id).references).toEqual(['a@1', 'b@1']);
    await workflow.dispose();
  });

  test('blocked and cancelled attempts satisfy a wake condition', async () => {
    const workflow = new DelegateWorkflowCoordinator({
      jobs: new DelegateJobManager(),
    });
    const gate = workflow.schedule({
      logicalId: 'gate',
      mode: 'single',
      tasks: ['gate'],
      execute: (signal) =>
        new Promise<DelegateJobResult>((resolve) =>
          signal.addEventListener(
            'abort',
            () => resolve(result('gate', 'error')),
            { once: true },
          ),
        ),
    });
    const blocked = workflow.schedule({
      logicalId: 'blocked',
      mode: 'single',
      tasks: ['blocked'],
      after: [gate.identity],
      execute: async () => result('never'),
    });
    workflow.block(blocked.identity, 'policy');
    const cancelled = workflow.schedule({
      logicalId: 'cancelled',
      mode: 'single',
      tasks: ['cancelled'],
      execute: async () => result('never'),
    });
    await workflow.cancel(cancelled.identity);
    const wake = new WakeCoordinator({ workflow });
    expect(
      wake.register({
        id: 'blocked-wake',
        condition: { node: blocked.identity },
        payload: ['metadata'],
      }).state,
    ).toBe('ready');
    expect(
      wake.register({
        id: 'cancelled-wake',
        condition: { node: cancelled.identity },
        payload: ['metadata'],
      }).state,
    ).toBe('ready');
    await workflow.dispose();
  });

  test('dispatch failure returns to ready and can be retried', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const attempt = workflow.schedule(
      options('build', async () => result('build')),
    );
    await settled(workflow, attempt.identity);
    const dispatches: WakeDispatch[] = [];
    let firstAcknowledgement!: WakeDispatch['acknowledgement'];
    let fail = true;
    const wake = new WakeCoordinator({
      workflow,
      dispatch: (dispatch) => {
        dispatches.push(dispatch);
        if (fail) {
          firstAcknowledgement = dispatch.acknowledgement;
          fail = false;
          throw new Error('queue unavailable');
        }
        wake.markEntered(dispatch.wake.id, dispatch.acknowledgement);
      },
    });
    expect(
      wake.register({ id: 'retryable', condition: { node: 'build' } }).state,
    ).toBe('ready');
    expect(wake.require('retryable').lastDispatchFailure).toContain(
      'queue unavailable',
    );
    expect(wake.retry('retryable').state).toBe('entered');
    expect(dispatches).toHaveLength(2);
    expect(() => wake.markEntered('retryable', firstAcknowledgement)).toThrow(
      /stale/,
    );
    await workflow.dispose();
  });

  test('cancellation prevents a queued dispatch from entering', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const attempt = workflow.schedule(
      options('build', async () => result('build')),
    );
    await settled(workflow, attempt.identity);
    let release!: () => void;
    const dispatch = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const wake = new WakeCoordinator({ workflow, dispatch });
    wake.register({ id: 'cancel-me', condition: { node: 'build' } });
    expect(wake.cancel('cancel-me').state).toBe('cancelled');
    release();
    await Promise.resolve();
    expect(wake.require('cancel-me').state).toBe('cancelled');
    await workflow.dispose();
  });

  test('lists active wakes while retaining terminal tombstones and capacity', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const gate = workflow.schedule({
      logicalId: 'capacity-gate',
      mode: 'single',
      tasks: ['capacity-gate'],
      execute: (signal) =>
        new Promise<DelegateJobResult>((resolve) =>
          signal.addEventListener(
            'abort',
            () => resolve(result('capacity-gate')),
            {
              once: true,
            },
          ),
        ),
    });
    const settledAttempt = workflow.schedule(
      options('terminal', async () => result('terminal')),
    );
    await settled(workflow, settledAttempt.identity);
    let wake!: WakeCoordinator;
    wake = new WakeCoordinator({
      workflow,
      dispatch: (dispatch) => {
        wake.markEntered(dispatch.wake.id, dispatch.acknowledgement);
      },
    });
    expect(
      wake.register({
        id: 'terminal-wake',
        condition: { node: settledAttempt.identity },
      }).state,
    ).toBe('entered');
    expect(wake.list()).toEqual([]);
    expect(wake.get('terminal-wake')).toMatchObject({ state: 'entered' });

    for (let index = 0; index < WAKE_MAX_SUBSCRIPTIONS; index++)
      wake.register({
        id: `active-${index}`,
        condition: { node: gate.identity },
      });
    expect(wake.list()).toHaveLength(WAKE_MAX_SUBSCRIPTIONS);
    expect(() =>
      wake.register({ id: 'overflow', condition: { node: gate.identity } }),
    ).toThrow('Too many wake subscriptions');
    await workflow.dispose();
  });

  test('snapshots and dispatches omit exact report/prose', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const handoff = 'secret exact report prose should not be persisted';
    const attempt = workflow.schedule({
      ...options('build', async () => ({ ...result('secret'), handoff })),
    });
    await settled(workflow, attempt.identity);
    const wake = new WakeCoordinator({ workflow });
    const snapshot = wake.register({
      id: 'safe',
      condition: { node: 'build' },
    });
    expect(JSON.stringify(snapshot)).not.toContain(handoff);
    expect(JSON.stringify(wake.snapshot())).not.toContain(handoff);
    await workflow.dispose();
  });

  test('deep-clones own __proto__ payload keys safely', () => {
    const selected = cloneAndFreezeWakeJson(
      JSON.parse('{"__proto__":{"safe":"yes"}}'),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(selected, '__proto__')).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(selected, '__proto__')?.value,
    ).toEqual({ safe: 'yes' });
    expect(Object.getPrototypeOf(selected)).toBeNull();
    expect(Object.isFrozen(selected)).toBe(true);
  });

  test('any readiness uses the ref that settles first, not references[0]', async () => {
    let finishA!: (value: DelegateJobResult) => void;
    const workflow = new DelegateWorkflowCoordinator();
    const a = workflow.schedule({
      ...options(
        'a',
        () => new Promise<DelegateJobResult>((resolve) => (finishA = resolve)),
      ),
    });
    const b = workflow.schedule(options('b', async () => result('b')));
    await settled(workflow, b.identity);
    const payloads: WakeDispatch[] = [];
    const wake = new WakeCoordinator({
      workflow,
      dispatch: (dispatch) => {
        payloads.push(dispatch);
      },
    });
    const registered = wake.register({
      id: 'first-any',
      condition: { any: [a.identity, b.identity] },
    });
    expect(registered.state).toBe('queued');
    expect(Object.keys(payloads[0]?.payload.sources ?? {})).toEqual(['b@1']);
    expect(wake.require('first-any').state).toBe('queued');
    finishA(result('a'));
    await workflow.dispose();
  });

  test('all readiness groups both sources by exact identity', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const a = workflow.schedule(options('a', async () => result('a')));
    const b = workflow.schedule(options('b', async () => result('b')));
    await settled(workflow, a.identity);
    await settled(workflow, b.identity);
    let payload!: WakeDispatch['payload'];
    const wake = new WakeCoordinator({
      workflow,
      dispatch: (dispatch) => {
        payload = dispatch.payload;
      },
    });
    wake.register({ id: 'both', condition: { all: [a.identity, b.identity] } });
    expect(Object.keys(payload.sources)).toEqual(['a@1', 'b@1']);
    expect(payload.sources['a@1']?.handoff).toContain('Outcome: a complete');
    expect(payload.sources['b@1']?.handoff).toContain('Outcome: b complete');
    expect(Object.isFrozen(payload.sources['a@1']?.metadata)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('runId');
    expect(payload.handoff).toBeUndefined();
    let explicitPayload!: WakeDispatch['payload'];
    const explicitWake = new WakeCoordinator({
      workflow,
      dispatch: (dispatch) => {
        explicitPayload = dispatch.payload;
      },
    });
    explicitWake.register({
      id: 'explicit-both',
      condition: { all: [a.identity, b.identity] },
      payload: [
        { kind: 'handoff', node: a.identity },
        { kind: 'metadata', node: b.identity },
      ],
    });
    expect(explicitPayload.sources['a@1']?.handoff).toContain(
      'Outcome: a complete',
    );
    expect(explicitPayload.sources['b@1']?.metadata?.identity).toBe('b@1');
    await workflow.dispose();
  });

  test('rejects an explicit payload source outside condition references', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const a = workflow.schedule(options('a', async () => result('a')));
    workflow.schedule(options('unrelated', async () => result('unrelated')));
    const wake = new WakeCoordinator({ workflow });
    expect(() =>
      wake.register({
        id: 'unrelated-payload',
        condition: { node: a.identity },
        payload: [{ kind: 'handoff', node: 'unrelated' }],
      }),
    ).toThrow(/not a condition reference/);
    await workflow.dispose();
  });

  test('keeps any pending when an explicit payload source is not terminal', async () => {
    let finishA!: (value: DelegateJobResult) => void;
    const workflow = new DelegateWorkflowCoordinator();
    const a = workflow.schedule({
      ...options(
        'a',
        () => new Promise<DelegateJobResult>((resolve) => (finishA = resolve)),
      ),
    });
    const b = workflow.schedule(options('b', async () => result('b')));
    await settled(workflow, b.identity);
    const wake = new WakeCoordinator({ workflow });
    const pending = wake.register({
      id: 'wait-explicit',
      condition: { any: [a.identity, b.identity] },
      payload: [{ kind: 'handoff', node: a.identity }],
    });
    expect(pending.state).toBe('pending');
    finishA(result('a'));
    await vi.waitFor(() =>
      expect(wake.require('wait-explicit').state).toBe('ready'),
    );
    await workflow.dispose();
  });

  test('persists ownership metadata and reports overlapping wakes', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const attempt = workflow.schedule(
      options('owned', async () => result('owned')),
    );
    await settled(workflow, attempt.identity);
    const warnings: string[] = [];
    const dispatches: WakeDispatch[] = [];
    let reentrantRejected = false;
    let wake!: WakeCoordinator;
    wake = new WakeCoordinator({
      workflow,
      ownerSessionId: 'session-a',
      ownerEpoch: 4,
      dispatch: (dispatch) => {
        dispatches.push(dispatch);
      },
      onWarning: ({ message }) => {
        warnings.push(message);
        try {
          wake.register({
            id: 'second',
            condition: { node: attempt.identity },
          });
        } catch {
          reentrantRejected = true;
        }
      },
    });
    wake.register({ id: 'first', condition: { node: attempt.identity } });
    const second = wake.register({
      id: 'second',
      condition: { node: attempt.identity },
    });
    expect(second).toMatchObject({
      ownerSessionId: 'session-a',
      ownerEpoch: 4,
      deliveryKey: 'session-a:4:second',
    });
    expect(second.warnings?.length).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(reentrantRejected).toBe(true);
    expect(dispatches[1]).toMatchObject({
      ownerSessionId: 'session-a',
      ownerEpoch: 4,
      deliveryKey: 'session-a:4:second',
      acknowledgement: {
        deliveryKey: 'session-a:4:second',
        dispatchGeneration: 1,
        dispatchAttempt: 1,
      },
    });
    expect(wake.snapshot()).toMatchObject({
      ownerSessionId: 'session-a',
      ownerEpoch: 4,
    });
    await workflow.dispose();
  });

  test('overlap warnings compare effective payload channels', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const a = workflow.schedule(options('channel-a', async () => result('a')));
    const b = workflow.schedule(options('channel-b', async () => result('b')));
    const c = workflow.schedule(options('channel-c', async () => result('c')));
    const warnings: string[] = [];
    const wake = new WakeCoordinator({
      workflow,
      onWarning: ({ message }) => warnings.push(message),
    });
    wake.register({
      id: 'ab-handoff',
      condition: { all: [a.identity, b.identity] },
      payload: ['handoff'],
    });
    wake.register({
      id: 'ac-handoff',
      condition: { all: [a.identity, c.identity] },
      payload: ['handoff'],
    });
    expect(warnings).toHaveLength(1);
    const differentWarnings: string[] = [];
    const different = new WakeCoordinator({
      workflow,
      onWarning: ({ message }) => differentWarnings.push(message),
    });
    different.register({
      id: 'ab-handoff',
      condition: { all: [a.identity, b.identity] },
      payload: ['handoff'],
    });
    different.register({
      id: 'ac-metadata',
      condition: { all: [a.identity, c.identity] },
      payload: ['metadata'],
    });
    expect(differentWarnings).toHaveLength(0);
    await workflow.dispose();
  });

  test('restores exact entered any-wake sources and rejects ambiguous old entries', async () => {
    let finishA!: (value: DelegateJobResult) => void;
    let finishB!: (value: DelegateJobResult) => void;
    const workflow = new DelegateWorkflowCoordinator();
    const a = workflow.schedule(
      options('entered-a', () => new Promise((resolve) => (finishA = resolve))),
    );
    const b = workflow.schedule(
      options('entered-b', () => new Promise((resolve) => (finishB = resolve))),
    );
    let wake!: WakeCoordinator;
    wake = new WakeCoordinator({
      workflow,
      ownerSessionId: 'entered-owner',
      ownerEpoch: 3,
      dispatch: (dispatch) => {
        wake.markEntered(dispatch.wake.id, dispatch.acknowledgement);
      },
    });
    wake.register({
      id: 'entered-any',
      condition: { any: [a.identity, b.identity] },
      payload: ['metadata'],
    });
    finishA(result('entered-a'));
    await vi.waitFor(() =>
      expect(wake.require('entered-any').state).toBe('entered'),
    );
    expect(wake.enteredSourceIdentities()).toEqual([a.identity]);

    const snapshot = wake.snapshot();
    const restored = new WakeCoordinator({
      workflow,
      ownerSessionId: 'entered-owner',
      ownerEpoch: 3,
    });
    expect(restored.restore(snapshot)).toBe(true);
    expect(restored.enteredSourceIdentities()).toEqual([a.identity]);

    const ambiguous = JSON.parse(JSON.stringify(snapshot)) as {
      wakes: Array<{ readyReferences?: readonly string[] }>;
    };
    delete ambiguous.wakes[0].readyReferences;
    const rejected = new WakeCoordinator({
      workflow,
      ownerSessionId: 'entered-owner',
      ownerEpoch: 3,
    });
    expect(rejected.restore(ambiguous)).toBe(false);
    expect(rejected.enteredSourceIdentities()).toEqual([]);
    finishB(result('entered-b'));
    await workflow.dispose();
  });

  test('validates stable IDs, empty/duplicate references, and duplicate subscriptions', () => {
    const workflow = new DelegateWorkflowCoordinator();
    workflow.schedule(options('build', async () => result('build')));
    const wake = new WakeCoordinator({ workflow });
    expect(() =>
      wake.register({ id: 'Wake', condition: { node: 'build' } }),
    ).toThrow(/Invalid wake ID/);
    expect(() =>
      wake.register({ id: 'empty', condition: { all: [] } }),
    ).toThrow(/cannot be empty/);
    expect(() =>
      wake.register({
        id: 'too-many',
        condition: {
          all: Array.from({ length: 33 }, (_, index) => `node-${index}`),
        },
      }),
    ).toThrow(/exceeds 32 references/);
    expect(() =>
      wake.register({
        id: 'duplicate',
        condition: { all: ['build', 'build@1'] },
      }),
    ).toThrow(/Duplicate wake all/);
    wake.register({ id: 'stable', condition: { node: 'build' } });
    expect(() =>
      wake.register({ id: 'stable', condition: { node: 'build' } }),
    ).toThrow(/already registered/);
  });
});
