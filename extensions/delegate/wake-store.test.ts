import { describe, expect, test, vi } from 'vitest';
import { WakeCoordinator } from './wake-coordinator';
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

  test('malformed and untrusted records fail closed', async () => {
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
