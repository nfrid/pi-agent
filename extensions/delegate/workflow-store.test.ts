import { describe, expect, test, vi } from 'vitest';
import { createRun } from './types';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';
import {
  attachWorkflowStore,
  latestWorkflowState,
  persistWorkflowState,
  WORKFLOW_ENTRY_TYPE,
  workflowStoreHistory,
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

  test('defers owner snapshots while a sibling runtime is active', () => {
    const coordinator = new DelegateWorkflowCoordinator({
      ownerBranchId: 'owner-branch',
    });
    const entries: unknown[] = [];
    let ownerActive = false;
    attachWorkflowStore(coordinator, piFor(entries), {
      isOwnerActive: () => ownerActive,
    });

    coordinator.schedule({
      logicalId: 'deferred',
      mode: 'single',
      tasks: ['deferred'],
      execute: async () => ({ runs: [], handoff: 'owner-only' }),
    });
    expect(entries).toHaveLength(0);

    ownerActive = true;
    persistWorkflowState(coordinator, piFor(entries), {
      isOwnerActive: () => ownerActive,
    });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('owner-only');
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

  test('persists a hosted process link while queued and after settlement', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const entries: unknown[] = [];
    attachWorkflowStore(coordinator, piFor(entries));
    const processJobId = '123e4567-e89b-42d3-a456-426614174000';
    coordinator.schedule({
      logicalId: 'hosted',
      mode: 'single',
      tasks: ['hosted'],
      sessionId: 'child-session',
      processJobId,
      execute: async () => ({ runs: [], handoff: '' }),
    });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            kind: 'delta',
            state: expect.objectContaining({
              attempts: expect.arrayContaining([
                expect.objectContaining({
                  identity: 'hosted@1',
                  state: 'queued',
                  sessionId: 'child-session',
                  processJobId,
                }),
              ]),
            }),
          }),
        }),
      ]),
    );
    await vi.waitFor(() =>
      expect(coordinator.require('hosted@1').state).toBe('success'),
    );
    expect(latestWorkflowState(branch(entries))?.attempts[0]).toMatchObject({
      sessionId: 'child-session',
      processJobId,
    });
    await coordinator.dispose();
  });

  test('persists the canonical child session identity on settled attempts', async () => {
    const coordinator = new DelegateWorkflowCoordinator();
    const entries: unknown[] = [];
    attachWorkflowStore(coordinator, piFor(entries));
    const run = createRun('review', undefined, {
      sessionId: 'child-session-1',
    });
    run.state = 'success';
    run.exitCode = 0;
    coordinator.schedule({
      logicalId: 'review',
      mode: 'single',
      tasks: ['review'],
      execute: async () => ({ runs: [run], handoff: 'secret report' }),
    });
    await vi.waitFor(() =>
      expect(coordinator.require('review@1').state).toBe('success'),
    );
    expect(coordinator.metadataSnapshot().attempts[0]).toMatchObject({
      identity: 'review@1',
      sessionId: 'child-session-1',
    });
    expect(latestWorkflowState(branch(entries))?.attempts[0]).toMatchObject({
      identity: 'review@1',
      sessionId: 'child-session-1',
    });
    expect(JSON.stringify(entries)).not.toContain('secret report');
    await coordinator.dispose();
  });

  test('uses linear-sized deltas for hundreds of lifecycle metadata changes', async () => {
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
            () => resolve({ runs: [], handoff: 'private' }),
            { once: true },
          ),
        ),
    });
    for (let index = 0; index < 240; index += 1)
      coordinator.schedule({
        logicalId: `step-${index}`,
        mode: 'single',
        tasks: [`step-${index}`],
        after: [gate.identity],
        execute: async () => ({ runs: [], handoff: 'private' }),
      });

    const data = entries.map(
      (entry) => (entry as { data: unknown }).data,
    ) as Array<{
      kind?: unknown;
      state?: { attempts?: unknown[] };
    }>;
    expect(data.every((entry) => entry.kind === 'delta')).toBe(true);
    expect(
      data.every((entry) => (entry.state?.attempts?.length ?? 0) <= 32),
    ).toBe(true);
    const serializedBytes = JSON.stringify(entries).length;
    const latestBytes = JSON.stringify(
      latestWorkflowState(branch(entries)),
    ).length;
    expect(serializedBytes).toBeLessThan(latestBytes * 4);
    expect(latestWorkflowState(branch(entries))?.attempts).toHaveLength(241);
    expect(workflowStoreHistory(branch(entries))).toHaveLength(entries.length);

    detach();
    await coordinator.cancel(gate.identity);
    await coordinator.dispose();
  });

  test('fails closed when a delta is malformed after a valid snapshot', () => {
    const valid = {
      type: 'custom',
      customType: WORKFLOW_ENTRY_TYPE,
      data: {
        version: 1,
        kind: 'snapshot',
        state: { version: 1, attempts: [] },
      },
    };
    const malformed = {
      type: 'custom',
      customType: WORKFLOW_ENTRY_TYPE,
      data: {
        version: 1,
        kind: 'delta',
        state: { version: 1, attempts: [{ identity: 'not-complete' }] },
      },
    };
    expect(latestWorkflowState(branch([valid, malformed]))).toBeUndefined();
    expect(workflowStoreHistory(branch([valid, malformed]))).toBeUndefined();
  });

  test('rejects noncanonical and inconsistent journal metadata as a whole', () => {
    const attempt = (overrides: Record<string, unknown> = {}) => ({
      logicalId: 'foo',
      attempt: 1,
      identity: 'foo@1',
      state: 'scheduled',
      dependencies: ['gate@1'],
      waitingFor: ['gate@1'],
      createdAt: 1,
      scheduledAt: 1,
      ...overrides,
    });
    const entry = (metadata: Record<string, unknown>) => ({
      type: 'custom',
      customType: WORKFLOW_ENTRY_TYPE,
      data: {
        version: 1,
        kind: 'snapshot',
        state: { version: 1, attempts: [metadata] },
      },
    });
    const malformed = [
      attempt({ logicalId: 'Foo', identity: 'Foo@1' }),
      attempt({ logicalId: 'foo\u0000bar', identity: 'foo\u0000bar@1' }),
      attempt({ identity: 'foo@2' }),
      attempt({ attempt: 0, identity: 'foo@0' }),
      attempt({ attempt: 1_000_000_000, identity: 'foo@1000000000' }),
      attempt({ dependencies: ['gate'] }),
      attempt({ dependencies: ['Gate@1'] }),
      attempt({ dependencies: ['gate@1', 'gate@1'] }),
      attempt({ waitingFor: ['other@1'] }),
      attempt({ state: 'running', sessionId: 'child-session' }),
      attempt({
        state: 'running',
        sessionId: 'child-session',
        processJobId: 'not-a-uuid',
      }),
      attempt({
        state: 'running',
        processJobId: '123e4567-e89b-42d3-a456-426614174000',
      }),
      attempt({
        dependencies: Array.from(
          { length: 33 },
          (_, index) => `gate-${index}@1`,
        ),
        waitingFor: [],
      }),
      attempt({
        dependencies: ['gate@1'],
        waitingFor: Array.from({ length: 33 }, (_, index) => `gate-${index}@1`),
      }),
    ];
    for (const metadata of malformed) {
      expect(latestWorkflowState(branch([entry(metadata)]))).toBeUndefined();
      expect(workflowStoreHistory(branch([entry(metadata)]))).toBeUndefined();
    }
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
