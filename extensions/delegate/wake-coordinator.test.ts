import { describe, expect, test, vi } from 'vitest';
import { DelegateJobManager, type DelegateJobResult } from './jobs';
import {
  captureDelegateResultEvent,
  normalizeInternalDelegateResultSpec,
  setDelegateResultSpec,
  settleDelegateResult,
} from './structured-result';
import { createRun } from './types';
import { WakeCoordinator, type WakeDispatch } from './wake-coordinator';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';

function result(
  task: string,
  state: 'success' | 'error' = 'success',
): DelegateJobResult {
  const run = createRun(task);
  run.state = state;
  run.exitCode = state === 'success' ? 0 : 1;
  run.finishedAt = Date.now();
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

function structuredResult(task: string, summary: string): DelegateJobResult {
  const run = createRun(task);
  run.state = 'success';
  run.exitCode = 0;
  const spec = normalizeInternalDelegateResultSpec({
    schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
    views: { summary: '/summary' },
  });
  setDelegateResultSpec(run, spec);
  captureDelegateResultEvent(run, { details: { summary } }, false);
  settleDelegateResult(run);
  return { runs: [run], handoff: `Status: success\\nOutcome: ${task}` };
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
        wake.markEntered(dispatch.wake.id);
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
      }).state,
    ).toBe('ready');
    expect(
      wake.register({
        id: 'cancelled-wake',
        condition: { node: cancelled.identity },
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
    let fail = true;
    const wake = new WakeCoordinator({
      workflow,
      dispatch: (dispatch) => {
        dispatches.push(dispatch);
        if (fail) {
          fail = false;
          throw new Error('queue unavailable');
        }
        wake.markEntered(dispatch.wake.id);
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

  test('snapshots and dispatches omit exact report/prose', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const handoff = 'secret exact report prose should not be persisted';
    const attempt = workflow.schedule({
      ...options('build', async () => ({ runs: [], handoff })),
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

  test('resolves only an explicit named view, not the complete structured value', async () => {
    const run = createRun('structured');
    run.state = 'success';
    run.exitCode = 0;
    const spec = normalizeInternalDelegateResultSpec({
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          secret: { type: 'string' },
        },
        required: ['summary', 'secret'],
      },
      views: { summary: '/summary' },
    });
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(
      run,
      { details: { summary: 'selected', secret: 'must stay private' } },
      false,
    );
    settleDelegateResult(run);
    const workflow = new DelegateWorkflowCoordinator();
    const attempt = workflow.schedule({
      logicalId: 'structured',
      mode: 'single',
      tasks: ['structured'],
      execute: async () => ({
        runs: [run],
        handoff: 'compact handoff',
      }),
    });
    await settled(workflow, attempt.identity);
    const payloads: WakeDispatch[] = [];
    const wake = new WakeCoordinator({
      workflow,
      dispatch: (dispatch) => {
        payloads.push(dispatch);
      },
    });
    wake.register({
      id: 'view-only',
      condition: { node: attempt.identity },
      payload: [{ view: 'summary' }],
    });
    expect(payloads[0]?.payload.views).toEqual({ summary: 'selected' });
    expect(JSON.stringify(payloads[0]?.payload)).not.toContain(
      'must stay private',
    );
    await workflow.dispose();
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
    expect(payload.sources['a@1']?.handoff).toContain('a complete');
    expect(payload.sources['b@1']?.handoff).toContain('b complete');
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
    expect(explicitPayload.sources['a@1']?.handoff).toContain('a complete');
    expect(explicitPayload.sources['b@1']?.metadata?.identity).toBe('b@1');
    await workflow.dispose();
  });

  test('duplicate named views remain separate across sources', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const a = workflow.schedule({
      logicalId: 'a',
      mode: 'single',
      tasks: ['a'],
      execute: async () => structuredResult('a', 'from-a'),
    });
    const b = workflow.schedule({
      logicalId: 'b',
      mode: 'single',
      tasks: ['b'],
      execute: async () => structuredResult('b', 'from-b'),
    });
    await settled(workflow, a.identity);
    await settled(workflow, b.identity);
    let payload!: WakeDispatch['payload'];
    const wake = new WakeCoordinator({
      workflow,
      dispatch: (dispatch) => {
        payload = dispatch.payload;
      },
    });
    wake.register({
      id: 'both-views',
      condition: { all: [a.identity, b.identity] },
      payload: [{ view: 'summary' }],
    });
    expect(payload.sources['a@1']?.views).toEqual({ summary: 'from-a' });
    expect(payload.sources['b@1']?.views).toEqual({ summary: 'from-b' });
    expect(payload.sources['a@1']?.views).not.toBe(
      payload.sources['b@1']?.views,
    );
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
