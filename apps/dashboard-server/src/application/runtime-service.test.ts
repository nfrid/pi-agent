import { DatabaseSync } from 'node:sqlite';
import { MAX_NON_IDEMPOTENT_ACTION_IDS } from '@pi-dashboard/extension-contributions';
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
    };
    const sendCommand = vi.fn(async () => ({ accepted: true }));
    const service = new RuntimeService(
      { sendCommand } as never,
      {} as never,
      {} as never,
      repository as never,
    );
    return { receipts, repository, sendCommand, service };
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

  it('stores only a bounded fingerprint for a large command payload', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      runMigrations(db);
      const repository = new SqliteOrchestrationRepository(db);
      const service = new RuntimeService(
        { sendCommand: vi.fn(async () => ({ accepted: true })) } as never,
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

describe('RuntimeService restart replay protection', () => {
  it('does not consume an ID for an unknown or unmanaged target', async () => {
    let canRestart = false;
    const manager = {
      canRestart: () => canRestart,
      restart: vi.fn(async () => ({ runtimeId: 'new-runtime' })),
    };
    const service = new RuntimeService(
      {} as never,
      manager as never,
      {} as never,
    );

    await expect(
      service.restart('missing', 'retry-after-precondition'),
    ).rejects.toMatchObject({ code: 'restart-precondition' });
    canRestart = true;
    await expect(
      service.restart('managed', 'retry-after-precondition'),
    ).resolves.toEqual({ runtimeId: 'new-runtime' });
    expect(manager.restart).toHaveBeenCalledOnce();
  });

  it('rejects duplicate IDs and fails closed at bounded capacity', async () => {
    const manager = {
      canRestart: () => true,
      restart: vi.fn(async () => ({ runtimeId: 'new-runtime' })),
    };
    const service = new RuntimeService(
      {} as never,
      manager as never,
      {} as never,
    );

    await service.restart('managed', 'same-id');
    await expect(service.restart('managed', 'same-id')).rejects.toMatchObject({
      code: 'duplicate-action-id',
    });
    for (let index = 1; index < MAX_NON_IDEMPOTENT_ACTION_IDS; index += 1)
      await service.restart('managed', `restart-${index}`);
    await expect(
      service.restart('managed', 'over-capacity'),
    ).rejects.toMatchObject({ code: 'action-command-capacity' });
  });
});
