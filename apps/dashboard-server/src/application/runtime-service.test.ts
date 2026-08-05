import { MAX_NON_IDEMPOTENT_ACTION_IDS } from '@pi-dashboard/extension-contributions';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeService } from './runtime-service.js';

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
