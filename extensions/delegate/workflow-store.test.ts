import { describe, expect, test, vi } from 'vitest';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';
import {
  attachWorkflowStore,
  latestWorkflowState,
  WORKFLOW_ENTRY_TYPE,
} from './workflow-store';

function branch(entries: unknown[]) {
  return { sessionManager: { getBranch: () => entries } } as never;
}

function piFor(entries: unknown[]) {
  return {
    appendEntry(type: string, data: unknown) {
      entries.push({ type: 'custom', customType: type, data });
    },
  };
}

describe('workflow store', () => {
  test('persists scheduled dependency metadata without execution payloads', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const entries: unknown[] = [];
    const detach = attachWorkflowStore(coordinator, piFor(entries));
    const gate = coordinator.schedule({
      logicalId: 'gate',
      mode: 'single',
      tasks: ['gate'],
      execute: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => resolve({ runs: [], handoff: 'secret handoff report' }),
            { once: true },
          ),
        ),
    });
    const later = coordinator.schedule({
      logicalId: 'later',
      mode: 'single',
      tasks: ['later'],
      after: [gate.identity],
      execute: async () => ({ runs: [], handoff: 'secret later handoff' }),
    });
    expect(later).toMatchObject({
      identity: 'later@1',
      state: 'scheduled',
      dependencies: ['gate@1'],
      waitingFor: ['gate@1'],
    });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(
      entries.every(
        (entry) => JSON.stringify(entry).includes('secret') === false,
      ),
    ).toBe(true);
    const latest = latestWorkflowState(branch(entries));
    expect(latest?.attempts.at(-1)).toMatchObject({
      identity: 'later@1',
      waitingFor: ['gate@1'],
    });
    expect(JSON.stringify(latest)).not.toContain('jobId');
    expect(JSON.stringify(latest)).not.toContain('inputs');
    detach();
    await coordinator.dispose();
  });

  test('keeps terminal success and blocked attempts as bounded metadata', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const entries: unknown[] = [];
    attachWorkflowStore(coordinator, piFor(entries));
    coordinator.schedule({
      logicalId: 'success',
      mode: 'single',
      tasks: ['success'],
      execute: async () => ({ runs: [], handoff: 'secret result' }),
    });
    await vi.waitFor(() =>
      expect(coordinator.require('success@1').state).toBe('success'),
    );
    const gate = coordinator.schedule({
      logicalId: 'block-gate',
      mode: 'single',
      tasks: ['block-gate'],
      execute: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => resolve({ runs: [], handoff: 'secret gate handoff' }),
            { once: true },
          ),
        ),
    });
    coordinator.schedule({
      logicalId: 'blocked',
      mode: 'single',
      tasks: ['blocked'],
      after: [gate.identity],
      execute: async () => ({ runs: [], handoff: 'secret blocked result' }),
    });
    coordinator.block('blocked@1', 'dependency unavailable');
    const state = latestWorkflowState(branch(entries));
    expect(state?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identity: 'success@1', state: 'success' }),
        expect.objectContaining({
          identity: 'blocked@1',
          state: 'blocked',
          reason: 'dependency unavailable',
        }),
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain('secret');
    await coordinator.dispose();
  });

  test('detach stops appending snapshots', () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const entries: unknown[] = [];
    const detach = attachWorkflowStore(coordinator, piFor(entries));
    detach();
    coordinator.schedule({
      logicalId: 'detached',
      mode: 'single',
      tasks: ['detached'],
      execute: async () => ({ runs: [], handoff: 'not persisted' }),
    });
    expect(entries).toHaveLength(0);
  });

  test('writes the versioned custom entry type', () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const entries: unknown[] = [];
    coordinator.schedule({
      logicalId: 'entry',
      mode: 'single',
      tasks: ['entry'],
      execute: async () => ({ runs: [], handoff: 'hidden' }),
    });
    const { appendEntry } = piFor(entries);
    appendEntry(WORKFLOW_ENTRY_TYPE, {
      version: 1,
      kind: 'snapshot',
      state: coordinator.metadataSnapshot(),
    });
    expect(entries[0]).toMatchObject({
      customType: WORKFLOW_ENTRY_TYPE,
      data: { version: 1, kind: 'snapshot' },
    });
  });
});
