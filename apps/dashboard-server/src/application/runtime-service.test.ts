import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../repositories/migrations.js';
import { SqliteOrchestrationRepository } from '../repositories/sqlite-orchestration-repository.js';
import { RuntimeService } from './runtime-service.js';

describe('RuntimeService runtime command receipts', () => {
  function fixture() {
    const receipts = new Map<string, Record<string, unknown>>();
    const repository = {
      getCommandReceipt: (id: string) => receipts.get(id),
      recordCommandReceipt: (receipt: Record<string, unknown>) => {
        receipts.set(receipt.idempotencyKey as string, receipt);
      },
      getSessionThreadLink: vi.fn(),
      getThread: vi.fn(),
      unsettleThread: vi.fn(),
    };
    const sendCommand = vi.fn(async () => ({ accepted: true }));
    const registry = { get: vi.fn(), sendCommand };
    const onThreadActivity = vi.fn();
    const service = new RuntimeService(
      registry as never,
      {} as never,
      {} as never,
      repository as never,
      onThreadActivity,
    );
    return {
      onThreadActivity,
      receipts,
      registry,
      repository,
      sendCommand,
      service,
    };
  }

  it('replays an acknowledged command after a lost response', async () => {
    const { service, sendCommand } = fixture();
    const command = { id: 'runtime-command-1', type: 'abort' } as const;
    await expect(
      service.commandWithReceipt('runtime-1', command),
    ).resolves.toEqual({
      runtimeId: 'runtime-1',
      commandId: command.id,
      status: 'completed',
      result: { accepted: true },
    });
    await expect(
      service.commandWithReceipt('runtime-1', command),
    ).resolves.toEqual({
      runtimeId: 'runtime-1',
      commandId: command.id,
      status: 'already-completed',
      result: { accepted: true },
    });
    expect(sendCommand).toHaveBeenCalledOnce();
  });

  it('unsettles the linked thread after a message is acknowledged', async () => {
    const value = fixture();
    value.registry.get.mockReturnValue({ session: { id: 'session-1' } });
    value.repository.getSessionThreadLink.mockReturnValue({
      threadId: 'thread-1',
    });
    value.repository.getThread.mockReturnValue({
      id: 'thread-1',
      settledAt: 10,
    });

    await value.service.commandWithReceipt('runtime-1', {
      id: 'message-1',
      type: 'prompt',
      text: 'Continue',
    });

    expect(value.repository.unsettleThread).toHaveBeenCalledWith(
      'thread-activity-message-1',
      'thread-1',
    );
    expect(value.onThreadActivity).toHaveBeenCalledOnce();
  });

  it('stores only a bounded fingerprint for a large command payload', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      runMigrations(db);
      const repository = new SqliteOrchestrationRepository(db);
      const service = new RuntimeService(
        {
          get: vi.fn(() => undefined),
          sendCommand: vi.fn(async () => ({ accepted: true })),
        } as never,
        {} as never,
        {} as never,
        repository,
      );
      const text = 'large prompt text '.repeat(5_000);
      await service.commandWithReceipt('runtime-1', {
        id: 'runtime-command-large',
        type: 'prompt',
        text,
      });
      const row = db
        .prepare('SELECT * FROM command_receipt WHERE idempotency_key=?')
        .get('runtime-command-large') as Record<string, unknown>;
      expect(Object.keys(row)).toContain('command_fingerprint');
      expect(Object.keys(row)).not.toContain('command_payload_json');
      expect(String(row.command_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(row.command_fingerprint)).not.toContain(text);
      expect(JSON.stringify(row)).not.toContain(text);
    } finally {
      db.close();
    }
  });

  it('shares concurrent duplicate execution and rejects a different payload', async () => {
    const { service, sendCommand } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendCommand.mockImplementation(async () => {
      await blocked;
      return { accepted: true };
    });
    const first = service.commandWithReceipt('runtime-1', {
      id: 'runtime-command-concurrent',
      type: 'abort',
    });
    const duplicate = service.commandWithReceipt('runtime-1', {
      id: 'runtime-command-concurrent',
      type: 'abort',
    });
    await expect(
      service.commandWithReceipt('runtime-1', {
        id: 'runtime-command-concurrent',
        type: 'shutdown',
      }),
    ).rejects.toMatchObject({ code: 'idempotency-conflict' });
    release();
    await expect(first).resolves.toMatchObject({ status: 'completed' });
    await expect(duplicate).resolves.toMatchObject({
      status: 'already-completed',
      result: { accepted: true },
    });
    expect(sendCommand).toHaveBeenCalledOnce();
  });

  it('conflicts when a stored ID changes runtime or payload', async () => {
    const { service } = fixture();
    const command = { id: 'runtime-command-conflict', type: 'abort' } as const;
    await service.commandWithReceipt('runtime-1', command);
    await expect(
      service.commandWithReceipt('runtime-2', command),
    ).rejects.toMatchObject({
      code: 'idempotency-conflict',
    });
    await expect(
      service.commandWithReceipt('runtime-1', {
        id: command.id,
        type: 'compact.cancel',
      }),
    ).rejects.toMatchObject({ code: 'idempotency-conflict' });
  });
});

describe('RuntimeService lifecycle mutation receipts', () => {
  function lifecycleFixture() {
    const receipts = new Map<string, Record<string, unknown>>();
    const repository = {
      getCommandReceipt: (id: string) => receipts.get(id),
      recordCommandReceipt: (receipt: Record<string, unknown>) => {
        receipts.set(receipt.idempotencyKey as string, receipt);
      },
      getSessionThreadLink: vi.fn(),
      getThread: vi.fn(),
      unsettleThread: vi.fn(),
    };
    const snapshots: unknown[] = [];
    const registry = {
      snapshots: () => snapshots,
      sendCommand: vi.fn(async () => ({ accepted: true })),
    };
    const manager = {
      launch: vi.fn(async () => ({ runtimeId: 'runtime-started' })),
      canRestart: vi.fn(() => true),
      restart: vi.fn(async () => ({ runtimeId: 'runtime-restarted' })),
      stop: vi.fn(async () => undefined),
    };
    const sessions = { rename: vi.fn(async () => ({ id: 'dormant' })) };
    const onThreadActivity = vi.fn();
    const service = new RuntimeService(
      registry as never,
      manager as never,
      sessions as never,
      repository as never,
      onThreadActivity,
    );
    return {
      manager,
      onThreadActivity,
      registry,
      repository,
      sessions,
      service,
      snapshots,
    };
  }

  it('executes start once across concurrent and response-loss retries', async () => {
    const fixture = lifecycleFixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.manager.launch.mockImplementation(async () => {
      await blocked;
      return { runtimeId: 'runtime-started' };
    });
    const input = {
      commandId: 'start-once',
      projectId: 'project-1',
      checkoutId: 'checkout-1',
    };
    const first = fixture.service.startWithReceipt(input);
    const concurrent = fixture.service.startWithReceipt(input);
    release();
    await expect(first).resolves.toMatchObject({ status: 'completed' });
    await expect(concurrent).resolves.toMatchObject({
      status: 'already-completed',
    });
    await expect(
      fixture.service.startWithReceipt(input),
    ).resolves.toMatchObject({
      status: 'already-completed',
      result: { runtimeId: 'runtime-started' },
    });
    expect(fixture.manager.launch).toHaveBeenCalledOnce();
  });

  it('waits for resumed session activity before unsetting settlement', async () => {
    const fixture = lifecycleFixture();
    fixture.repository.getSessionThreadLink.mockReturnValue({
      threadId: 'thread-1',
    });
    fixture.repository.getThread.mockReturnValue({
      id: 'thread-1',
      settledAt: 10,
    });

    await fixture.service.startWithReceipt({
      commandId: 'resume-1',
      projectId: 'project-1',
      checkoutId: 'checkout-1',
      sessionId: 'session-1',
    });
    expect(fixture.repository.unsettleThread).not.toHaveBeenCalled();

    fixture.service.activateSession('session-1', 'working-1');
    expect(fixture.repository.unsettleThread).toHaveBeenCalledWith(
      'thread-activity-working-1',
      'thread-1',
    );
    expect(fixture.onThreadActivity).toHaveBeenCalledOnce();
  });

  it('replays restart and rejects a force-stop payload conflict', async () => {
    const fixture = lifecycleFixture();
    const restart = { commandId: 'restart-once', runtimeId: 'runtime-1' };
    await expect(
      fixture.service.restartWithReceipt(restart),
    ).resolves.toMatchObject({
      status: 'completed',
      result: { runtimeId: 'runtime-restarted' },
    });
    await expect(
      fixture.service.restartWithReceipt(restart),
    ).resolves.toMatchObject({
      status: 'already-completed',
    });
    expect(fixture.manager.restart).toHaveBeenCalledOnce();
    await expect(
      fixture.service.restartWithReceipt({
        commandId: 'restart-once',
        runtimeId: 'runtime-2',
      }),
    ).rejects.toMatchObject({ code: 'idempotency-conflict' });

    await fixture.service.stopWithReceipt({
      commandId: 'stop-force',
      runtimeId: 'runtime-1',
      force: true,
    });
    await expect(
      fixture.service.stopWithReceipt({
        commandId: 'stop-force',
        runtimeId: 'runtime-1',
        force: false,
      }),
    ).rejects.toMatchObject({ code: 'idempotency-conflict' });
  });

  it('resolves live and dormant rename targets during execution', async () => {
    const fixture = lifecycleFixture();
    fixture.snapshots.push({
      runtimeId: 'runtime-live',
      online: true,
      session: { id: 'session-live' },
    });
    const live = {
      commandId: 'rename-live',
      sessionId: 'session-live',
      name: 'Live title',
    };
    await fixture.service.renameWithReceipt(live);
    fixture.snapshots.length = 0;
    await expect(
      fixture.service.renameWithReceipt(live),
    ).resolves.toMatchObject({
      status: 'already-completed',
    });
    expect(fixture.registry.sendCommand).toHaveBeenCalledOnce();
    expect(fixture.registry.sendCommand).toHaveBeenCalledWith(
      'runtime-live',
      expect.objectContaining({ id: 'rename-live', type: 'setSessionName' }),
    );
    expect(fixture.sessions.rename).not.toHaveBeenCalled();

    const dormant = {
      commandId: 'rename-dormant',
      sessionId: 'session-dormant',
      name: 'Dormant title',
    };
    await fixture.service.renameWithReceipt(dormant);
    await fixture.service.renameWithReceipt(dormant);
    expect(fixture.sessions.rename).toHaveBeenCalledOnce();
  });
});
