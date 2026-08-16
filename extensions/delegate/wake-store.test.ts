import { describe, expect, test, vi } from 'vitest';
import { WAKE_MAX_SUBSCRIPTIONS, WakeCoordinator } from './wake-coordinator';
import {
  attachWakeStore,
  persistWakeState,
  restoreWakeState,
  WAKE_ENTRY_TYPE,
} from './wake-store';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';

function branch(entries: unknown[]) {
  return {
    sessionManager: { getBranch: () => entries },
  } as never;
}

describe('wake store', () => {
  test('persists metadata append-only and restores from the current branch', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const entries: unknown[] = [];
    const pi = {
      appendEntry(type: string, data: unknown) {
        entries.push({ type: 'custom', customType: type, data });
      },
    };
    const wake = new WakeCoordinator({ workflow });
    workflow.schedule({
      logicalId: 'build',
      mode: 'single',
      tasks: ['build'],
      execute: async () => ({
        runs: [],
        handoff: 'exact report prose must never enter the session entry',
      }),
    });
    const subscription = wake.register({
      id: 'review',
      condition: { node: 'build' },
    });
    expect(subscription.state).toBe('pending');
    persistWakeState(wake, pi);
    await vi.waitFor(() =>
      expect(workflow.require('build@1').settledAt).toBeDefined(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ customType: WAKE_ENTRY_TYPE });
    expect(JSON.stringify(entries)).not.toContain('exact report prose');
    const persistedWake = (
      entries[0] as { data: { state: { wakes: Array<{ payload: unknown }> } } }
    ).data.state.wakes[0];
    expect(persistedWake?.payload).toEqual([
      { kind: 'handoff' },
      { kind: 'metadata' },
    ]);
    workflow.schedule({
      logicalId: 'build',
      continuation: true,
      mode: 'single',
      tasks: ['build-again'],
      execute: async () => ({ runs: [], handoff: 'later' }),
    });

    const restored = new WakeCoordinator({ workflow });
    restoreWakeState(restored, branch(entries));
    expect(restored.require('review')).toMatchObject({
      id: 'review',
      state: 'ready',
      references: ['build@1'],
    });
    expect(restored.snapshot().wakes[0]).not.toHaveProperty('payload.handoff');
    await workflow.dispose();
  });

  test('attach appends state transitions without replacing old entries', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const entries: unknown[] = [];
    const pi = {
      appendEntry(_type: string, data: unknown) {
        entries.push(data);
      },
    };
    const gate = workflow.schedule({
      logicalId: 'gate',
      mode: 'single',
      tasks: ['gate'],
      execute: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => resolve({ runs: [], handoff: 'gate aborted' }),
            { once: true },
          ),
        ),
    });
    const later = workflow.schedule({
      logicalId: 'later',
      mode: 'single',
      tasks: ['later'],
      after: [gate.identity],
      execute: async () => ({ runs: [], handoff: 'later' }),
    });
    const wake = new WakeCoordinator({ workflow });
    const detach = attachWakeStore(wake, pi);
    wake.register({ id: 'waiting', condition: { node: later.identity } });
    expect(entries).toHaveLength(1);
    expect((entries[0] as { state: unknown }).state).toBeDefined();
    detach();
    wake.cancel('waiting');
    expect(entries).toHaveLength(1);
    await workflow.dispose();
  });

  test('does not redeliver restored queued entries until explicit reconciliation', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    workflow.schedule({
      logicalId: 'queued',
      mode: 'single',
      tasks: ['queued'],
      execute: async () => ({ runs: [], handoff: 'queued' }),
    });
    await vi.waitFor(() =>
      expect(workflow.require('queued@1').settledAt).toBeDefined(),
    );
    const entries: unknown[] = [];
    const original = new WakeCoordinator({
      workflow,
      ownerSessionId: 'session-q',
      ownerEpoch: 2,
      dispatch: () => {
        // Simulate a process crash after queueing and before entry.
      },
    });
    original.register({ id: 'queued-wake', condition: { node: 'queued' } });
    persistWakeState(original, {
      appendEntry(_type: string, data: unknown) {
        entries.push({
          type: 'custom',
          customType: WAKE_ENTRY_TYPE,
          data,
        });
      },
    });
    let dispatches = 0;
    let acknowledgement!: Parameters<WakeCoordinator['markEntered']>[1];
    const restored = new WakeCoordinator({
      workflow,
      ownerSessionId: 'session-q',
      ownerEpoch: 2,
      dispatch: (dispatch) => {
        dispatches++;
        acknowledgement = dispatch.acknowledgement;
      },
    });
    restoreWakeState(restored, branch(entries));
    expect(restored.require('queued-wake').state).toBe('queued');
    expect(dispatches).toBe(0);
    expect(restored.retryDispatch('queued-wake').state).toBe('queued');
    expect(dispatches).toBe(1);
    expect(restored.markEntered('queued-wake', acknowledgement).state).toBe(
      'entered',
    );
    expect(restored.markEntered('queued-wake', acknowledgement).state).toBe(
      'entered',
    );
    await workflow.dispose();
  });

  test('rejects ownership-mismatched snapshots without changing live state', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    workflow.schedule({
      logicalId: 'owned',
      mode: 'single',
      tasks: ['owned'],
      execute: async () => ({ runs: [], handoff: 'owned' }),
    });
    await vi.waitFor(() =>
      expect(workflow.require('owned@1').settledAt).toBeDefined(),
    );
    const source = new WakeCoordinator({
      workflow,
      ownerSessionId: 'source',
      ownerEpoch: 1,
    });
    source.register({ id: 'owned-wake', condition: { node: 'owned' } });
    const target = new WakeCoordinator({
      workflow,
      ownerSessionId: 'target',
      ownerEpoch: 1,
    });
    restoreWakeState(
      target,
      branch([
        {
          type: 'custom',
          customType: WAKE_ENTRY_TYPE,
          data: {
            version: 1,
            kind: 'snapshot',
            state: source.snapshot(),
          },
        },
      ]),
    );
    expect(target.list()).toEqual([]);
    await workflow.dispose();
  });

  test('enforces the subscription cap after merging restored and live wakes', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const gate = workflow.schedule({
      logicalId: 'cap-gate',
      mode: 'single',
      tasks: ['cap-gate'],
      execute: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => resolve({ runs: [], handoff: 'gate' }),
            { once: true },
          ),
        ),
    });
    for (let index = 0; index <= WAKE_MAX_SUBSCRIPTIONS; index++)
      workflow.schedule({
        logicalId: `cap-node-${index}`,
        mode: 'single',
        tasks: [`cap-node-${index}`],
        after: [gate.identity],
        execute: async () => ({ runs: [], handoff: 'cap' }),
      });
    const source = new WakeCoordinator({ workflow });
    for (let index = 0; index < WAKE_MAX_SUBSCRIPTIONS; index++)
      source.register({
        id: `cap-wake-${index}`,
        condition: { node: `cap-node-${index}` },
      });
    const target = new WakeCoordinator({ workflow });
    target.register({
      id: 'live-cap-wake',
      condition: { node: `cap-node-${WAKE_MAX_SUBSCRIPTIONS}` },
    });
    target.restore(source.snapshot());
    expect(target.list()).toHaveLength(1);
    expect(target.require('live-cap-wake').state).toBe('pending');
    await workflow.dispose();
  });

  test('invalid records leave existing wakes unchanged as one transaction', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    workflow.schedule({
      logicalId: 'live',
      mode: 'single',
      tasks: ['live'],
      execute: async () => ({ runs: [], handoff: 'live' }),
    });
    await vi.waitFor(() =>
      expect(workflow.require('live@1').settledAt).toBeDefined(),
    );
    const wake = new WakeCoordinator({ workflow });
    wake.register({ id: 'live-wake', condition: { node: 'live' } });
    const snapshot = wake.snapshot();
    wake.restore({
      ...snapshot,
      wakes: [
        ...snapshot.wakes,
        {
          id: 'bad id',
          condition: { node: 'live@1' },
          references: ['live@1'],
          payload: [{ kind: 'handoff' }],
          state: 'pending',
          createdAt: 1,
          revision: 1,
          dispatchAttempts: 0,
        },
      ],
    });
    expect(wake.require('live-wake').state).toBe('ready');
    expect(wake.list()).toHaveLength(1);
    await workflow.dispose();
  });

  test('restore validates readyReferences against condition semantics', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const a = workflow.schedule({
      logicalId: 'ready-a',
      mode: 'single',
      tasks: ['ready-a'],
      execute: async () => ({ runs: [], handoff: 'a' }),
    });
    const b = workflow.schedule({
      logicalId: 'ready-b',
      mode: 'single',
      tasks: ['ready-b'],
      execute: async () => ({ runs: [], handoff: 'b' }),
    });
    await vi.waitFor(() =>
      expect(workflow.require(a.identity).settledAt).toBeDefined(),
    );
    await vi.waitFor(() =>
      expect(workflow.require(b.identity).settledAt).toBeDefined(),
    );
    const source = new WakeCoordinator({ workflow });
    source.register({
      id: 'all-ready',
      condition: { all: [a.identity, b.identity] },
    });
    const snapshot = source.snapshot();
    const wake = snapshot.wakes[0];
    if (!wake) throw new Error('missing ready wake');
    const invalid = {
      ...snapshot,
      wakes: [{ ...wake, readyReferences: [a.identity] }],
    };
    const target = new WakeCoordinator({ workflow });
    target.restore(invalid);
    expect(target.list()).toEqual([]);
    await workflow.dispose();
  });

  test('history keeps entered state over a later stale high-revision pending snapshot', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    workflow.schedule({
      logicalId: 'history',
      mode: 'single',
      tasks: ['history'],
      execute: async () => ({ runs: [], handoff: 'history' }),
    });
    await vi.waitFor(() =>
      expect(workflow.require('history@1').settledAt).toBeDefined(),
    );
    let entered!: WakeCoordinator;
    entered = new WakeCoordinator({
      workflow,
      ownerSessionId: 'history-owner',
      ownerEpoch: 3,
      dispatch: (dispatch) => {
        entered.markEntered(dispatch.wake.id, dispatch.acknowledgement);
      },
    });
    entered.register({ id: 'history-wake', condition: { node: 'history' } });
    const enteredSnapshot = entered.snapshot();
    const enteredWake = enteredSnapshot.wakes[0];
    if (!enteredWake?.enteredAcknowledgement)
      throw new Error('missing entered wake acknowledgement');
    const staleWake = {
      ...enteredWake,
      state: 'pending' as const,
      revision: enteredWake.revision + 100,
      readyAt: undefined,
      readyReferences: undefined,
      queuedAt: undefined,
      enteredAt: undefined,
      enteredAcknowledgement: undefined,
      dispatchGeneration: 0,
      dispatchAttempts: 0,
    };
    const staleSnapshot = {
      ...enteredSnapshot,
      wakes: [staleWake],
    };
    let dispatches = 0;
    const restored = new WakeCoordinator({
      workflow,
      ownerSessionId: 'history-owner',
      ownerEpoch: 3,
      dispatch: () => {
        dispatches++;
      },
    });
    restoreWakeState(
      restored,
      branch([
        {
          type: 'custom',
          customType: WAKE_ENTRY_TYPE,
          data: { version: 1, kind: 'snapshot', state: enteredSnapshot },
        },
        {
          type: 'custom',
          customType: WAKE_ENTRY_TYPE,
          data: { version: 1, kind: 'snapshot', state: staleSnapshot },
        },
      ]),
    );
    expect(restored.require('history-wake').state).toBe('entered');
    expect(
      restored.markEntered('history-wake', enteredWake.enteredAcknowledgement)
        .state,
    ).toBe('entered');
    expect(dispatches).toBe(0);
    await workflow.dispose();
  });

  test('malformed and untrusted records fail closed transactionally', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const wake = new WakeCoordinator({ workflow });
    restoreWakeState(
      wake,
      branch([
        {
          type: 'custom',
          customType: WAKE_ENTRY_TYPE,
          data: {
            version: 1,
            kind: 'snapshot',
            state: {
              version: 1,
              ownerSessionId: 'default',
              ownerEpoch: 0,
              wakes: [
                {
                  id: 'bad id',
                  condition: { node: 'missing@1' },
                  references: ['missing@1'],
                  payload: ['handoff'],
                  state: 'pending',
                  createdAt: 1,
                  dispatchAttempts: 0,
                },
                {
                  id: 'also-bad',
                  condition: { all: [] },
                  payload: ['handoff'],
                  state: 'pending',
                  createdAt: 1,
                  dispatchAttempts: 0,
                  evidence: 'raw untrusted report prose',
                },
              ],
            },
          },
        },
      ]),
    );
    expect(wake.list()).toEqual([]);
    expect(JSON.stringify(wake.snapshot())).not.toContain(
      'raw untrusted report prose',
    );
    await workflow.dispose();
  });
});
