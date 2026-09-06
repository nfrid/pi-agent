import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeService } from './application/runtime-service.js';
import { MetadataStore } from './metadata.js';
import { RuntimeManager } from './runtime-manager.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-intent-recovery-'));
  const file = path.join(root, 'dashboard.sqlite');
  let metadata = new MetadataStore(file);
  const { project, checkout } =
    metadata.orchestration.createProjectWithCheckout(
      { id: 'project', title: 'Recovery', rootPath: root },
      { id: 'checkout', kind: 'main', path: root, status: 'ready' },
    );
  const snapshots = new Map<string, RuntimeSnapshot>();
  const registry = {
    get: (id: string) => snapshots.get(id),
    snapshots: () => [...snapshots.values()],
    forget: (id: string) => snapshots.delete(id),
    isOnline: () => false,
    sendCommand: vi.fn(async (): Promise<unknown> => ({ accepted: true })),
  };
  const sessions = { get: vi.fn(() => undefined) };
  const provider = {
    start: vi.fn(async (request: { runtimeId: string }) => ({
      runtimeId: request.runtimeId,
      location: { id: `runtime-host:${request.runtimeId}` },
    })),
    stop: vi.fn(async () => undefined),
  };
  const build = () => {
    const manager = new RuntimeManager(
      registry as never,
      provider as never,
      sessions as never,
      metadata,
      path.join(root, 'bridge.sock'),
      metadata.orchestration,
    );
    const service = new RuntimeService(
      registry as never,
      manager,
      sessions as never,
      metadata.orchestration,
    );
    return { manager, service };
  };
  let current = build();
  cleanup.push(async () => {
    metadata.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    checkout,
    registry,
    snapshots,
    sessions,
    provider,
    get metadata() {
      return metadata;
    },
    get manager() {
      return current.manager;
    },
    get service() {
      return current.service;
    },
    reopen() {
      metadata.close();
      metadata = new MetadataStore(file);
      current = build();
    },
    start: {
      commandId: 'start',
      runtimeId: 'new-runtime',
      projectId: project.id,
      checkoutId: checkout.id,
    },
    async original() {
      const sessionFile = path.join(root, 'original.jsonl');
      await writeFile(
        sessionFile,
        `${JSON.stringify({ type: 'session', id: 'session-original' })}\n`,
      );
      await current.manager.launch({
        projectId: project.id,
        checkoutId: checkout.id,
        runtimeId: 'original',
        mode: 'read',
      });
      snapshots.set('original', {
        runtimeId: 'original',
        ownership: 'managed',
        cwd: root,
        pid: 1,
        liveState: 'idle',
        session: {
          id: 'session-original',
          file: sessionFile,
          name: 'Original',
          entries: [],
        },
        model: {
          provider: 'openai-codex',
          model: 'test-model',
          thinking: 'high',
          serviceTier: 'ultrafast',
        },
      });
      return sessionFile;
    },
  };
}

describe('durable runtime intent boundaries', () => {
  it('rejects pending shared-namespace lookup after reopen while exposing runtime recovery lookup', async () => {
    const f = await fixture();
    f.metadata.orchestration.reserveCommandIntent({
      idempotencyKey: 'pending',
      commandType: 'runtime.start',
      commandFingerprint: 'a'.repeat(64),
      plannedRuntimeId: 'reserved',
      executionPlan: { operation: 'start', runtimeId: 'reserved' },
    });
    f.reopen();
    expect(() =>
      f.metadata.orchestration.getCommandReceipt('pending'),
    ).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }));
    expect(f.metadata.orchestration.getCommandIntent('pending')).toMatchObject({
      executionState: 'prepared',
      plannedRuntimeId: 'reserved',
    });
  });

  it('cannot steal a prepared identity or reuse historical credentials through direct launch', async () => {
    const f = await fixture();
    f.metadata.orchestration.reserveCommandIntent({
      idempotencyKey: 'owner',
      commandType: 'runtime.start',
      commandFingerprint: 'a'.repeat(64),
      plannedRuntimeId: f.start.runtimeId,
      executionPlan: { operation: 'start', runtimeId: f.start.runtimeId },
    });
    const { commandId: _, ...request } = f.start;
    await expect(f.manager.launch(request)).rejects.toThrow('another intent');
    await expect(
      f.manager.launch(request, { owningIntentId: 'owner' }),
    ).rejects.toThrow('reservation');
    expect(f.provider.start).not.toHaveBeenCalled();
    f.metadata.orchestration.transitionCommandIntent('owner', 'launching');
    await f.manager.launch(request, { owningIntentId: 'owner' });
    await f.manager.stop(request.runtimeId);
    const prior = f.metadata.managedLaunchHistory();
    f.reopen();
    await expect(
      f.manager.launch(request, { owningIntentId: 'owner' }),
    ).rejects.toThrow('already been used');
    expect(() =>
      f.metadata.recordManagedLaunch(
        request.runtimeId,
        {},
        { id: 'stolen' },
        { identityToken: 'stolen', launchToken: 'stolen' },
        'owner',
      ),
    ).toThrow();
    expect(f.metadata.managedLaunchHistory()).toEqual(prior);
    expect(f.provider.start).toHaveBeenCalledOnce();
  });

  it('does not infer readiness from provider side effects before the durable ready proof', async () => {
    const f = await fixture();
    vi.spyOn(f.metadata, 'markManagedReady').mockImplementationOnce(() => {
      throw new Error('crash before ready proof');
    });
    f.provider.stop.mockRejectedValueOnce(
      new Error('host unavailable during cleanup'),
    );
    await expect(f.service.startWithReceipt(f.start)).rejects.toThrow(
      'host unavailable',
    );
    f.reopen();
    await f.service.reconcilePendingIntents();
    expect(f.metadata.orchestration.getCommandIntent('start')).toMatchObject({
      executionState: 'uncertain',
    });
    await expect(f.service.startWithReceipt(f.start)).rejects.toMatchObject({
      code: 'runtime-command-uncertain',
    });
    expect(f.provider.start).toHaveBeenCalledOnce();
  });

  it('reconstructs completion after ready proof and receipt-write failure without starting again', async () => {
    const f = await fixture();
    vi.spyOn(
      f.metadata.orchestration,
      'completeCommandIntent',
    ).mockImplementationOnce(() => {
      throw new Error('receipt write failed');
    });
    await expect(f.service.startWithReceipt(f.start)).rejects.toThrow(
      'receipt write failed',
    );
    f.reopen();
    await f.service.reconcilePendingIntents();
    await expect(f.service.startWithReceipt(f.start)).resolves.toMatchObject({
      status: 'already-completed',
      result: { runtimeId: f.start.runtimeId },
    });
    expect(f.provider.start).toHaveBeenCalledOnce();
  });

  it('resumes the exact captured session and all configuration after stopping the original and losing the index', async () => {
    const f = await fixture();
    const sessionFile = await f.original();
    const repository = f.metadata.orchestration;
    const transition = repository.transitionCommandIntent.bind(repository);
    vi.spyOn(repository, 'transitionCommandIntent').mockImplementation(
      (id, state) => {
        if (state === 'launching') throw new Error('crash after old stop');
        return transition(id, state);
      },
    );
    await expect(
      f.service.restartWithReceipt({
        commandId: 'restart',
        runtimeId: 'original',
      }),
    ).rejects.toThrow('crash after old stop');
    expect(f.manager.reconcileStop('original')).toBe(true);
    expect(f.sessions.get()).toBeUndefined();
    f.reopen();
    await f.service.reconcilePendingIntents();
    expect(f.metadata.orchestration.getCommandReceipt('restart')).toMatchObject(
      { result: { runtimeId: expect.any(String) } },
    );
    expect(f.provider.start).toHaveBeenCalledTimes(2);
    expect(f.provider.start.mock.calls[1]?.[0]).toMatchObject({
      sessionId: 'session-original',
      sessionFile,
      name: 'Original',
      mode: 'read',
      runtimeProvider: 'extension-bridge',
      model: {
        provider: 'openai-codex',
        model: 'test-model',
        thinking: 'high',
        serviceTier: 'ultrafast',
      },
    });
  });

  it.each([
    'archived-project',
    'missing-session',
  ] as const)('rejects changed %s prerequisites before stopping', async (change) => {
    const f = await fixture();
    const sessionFile = await f.original();
    const prepared = await f.manager.prepareRestart('original');
    if (change === 'archived-project')
      f.metadata.orchestration.transitionProject(f.project.id, 'archived');
    else await rm(sessionFile);
    await expect(f.manager.restartPrepared(prepared)).rejects.toThrow();
    expect(f.provider.stop).not.toHaveBeenCalled();
    expect(f.snapshots.has('original')).toBe(true);
  });

  it('revalidates a persisted prepared restart after configuration changes before old stop', async () => {
    const f = await fixture();
    await f.original();
    vi.spyOn(
      f.metadata.orchestration,
      'transitionCommandIntent',
    ).mockImplementationOnce(() => {
      throw new Error('crash before stopping');
    });
    const input = { commandId: 'restart-prepared', runtimeId: 'original' };
    await expect(f.service.restartWithReceipt(input)).rejects.toThrow(
      'crash before stopping',
    );
    f.metadata.orchestration.transitionProject(f.project.id, 'archived');
    f.reopen();
    await expect(f.service.restartWithReceipt(input)).rejects.toThrow(
      'Project is archived',
    );
    expect(f.provider.stop).not.toHaveBeenCalled();
    expect(f.snapshots.has('original')).toBe(true);
  });

  it('refuses restart without exact session evidence instead of creating a fresh session', async () => {
    const f = await fixture();
    await f.original();
    delete f.snapshots.get('original')?.session.file;
    await expect(
      f.service.restartWithReceipt({
        commandId: 'restart',
        runtimeId: 'original',
      }),
    ).rejects.toThrow('session evidence');
    expect(f.provider.stop).not.toHaveBeenCalled();
  });

  it('never redispatches after an ACK followed by receipt-write failure', async () => {
    const f = await fixture();
    vi.spyOn(
      f.metadata.orchestration,
      'completeCommandIntent',
    ).mockImplementationOnce(() => {
      throw new Error('receipt write failed');
    });
    const command = { id: 'ack-lost', type: 'abort' } as const;
    await expect(
      f.service.commandWithReceipt('external', command),
    ).rejects.toThrow('receipt write failed');
    f.reopen();
    await f.service.reconcilePendingIntents();
    await expect(
      f.service.commandWithReceipt('external', command),
    ).rejects.toMatchObject({ code: 'runtime-command-uncertain' });
    expect(f.registry.sendCommand).toHaveBeenCalledOnce();
  });

  it('fails closed when an acknowledgement impersonates a receipt', async () => {
    const f = await fixture();
    f.registry.sendCommand.mockResolvedValue({
      runtimeId: 'other',
      commandId: 'forged',
      status: 'already-completed',
      result: { accepted: true },
    });
    await expect(
      f.service.commandWithReceipt('external', {
        id: 'forged-ack',
        type: 'abort',
      }),
    ).rejects.toThrow('impersonate');
    expect(
      f.metadata.orchestration.getCommandIntent('forged-ack'),
    ).toMatchObject({ executionState: 'dispatched' });
  });

  it('does not rewrite old completed receipt results', async () => {
    const f = await fixture();
    const command = { id: 'old-receipt', type: 'abort' } as const;
    await f.service.commandWithReceipt('external', command);
    const oldResult = { accepted: true, legacyOutput: 'persisted contract' };
    f.metadata.db
      .prepare(
        'UPDATE command_receipt SET result_json=? WHERE idempotency_key=?',
      )
      .run(JSON.stringify(oldResult), command.id);
    f.reopen();
    const receipt = f.metadata.orchestration.getCommandReceipt(command.id);
    if (!receipt) throw new Error('Expected completed receipt.');
    f.metadata.orchestration.completeCommandIntent({
      ...receipt,
      result: { accepted: true },
    });
    await expect(
      f.service.commandWithReceipt('external', command),
    ).resolves.toMatchObject({
      status: 'already-completed',
      result: oldResult,
    });
    expect(f.registry.sendCommand).toHaveBeenCalledOnce();
  });
});
