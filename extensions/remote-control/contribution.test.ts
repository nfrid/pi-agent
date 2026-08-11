import { describe, expect, it, vi } from 'vitest';
import { InteractionBroker } from '../ask-user/broker';
import {
  RUNTIME_ABORT_ACTION_ID,
  RUNTIME_SHUTDOWN_ACTION_ID,
  remoteControlCapabilitySnapshot,
  remoteControlManifest,
  SESSION_COMPACT_ACTION_ID,
} from './contribution';
import { dispatchDashboardCommand } from './index';
import { registerRemoteControlCapability } from './register-capability';

registerRemoteControlCapability();

describe('remote-control semantic lifecycle contribution', () => {
  it('advertises only context-backed lifecycle actions', () => {
    const ids = remoteControlManifest.actions.map((action) => action.id);
    expect(ids).toEqual([
      SESSION_COMPACT_ACTION_ID,
      RUNTIME_ABORT_ACTION_ID,
      RUNTIME_SHUTDOWN_ACTION_ID,
    ]);
    expect(ids).not.toContain('session.new');
    expect(ids).not.toContain('session.resume');
    expect(ids).not.toContain('session.fork');
    expect(ids).not.toContain('session.tree');
    expect(ids).not.toContain('runtime.reload');
    expect(remoteControlCapabilitySnapshot.capabilities[0]?.id).toBe(
      'remote-control.semantic-actions',
    );
  });

  it('dispatches compact through action.invoke without slash parsing', async () => {
    let completed = false;
    const compact = vi.fn(async () => {
      await Promise.resolve();
      completed = true;
    });
    const context = {
      compact,
      isIdle: () => true,
      abort: vi.fn(),
      shutdown: vi.fn(),
    } as never;
    await expect(
      dispatchDashboardCommand(
        {} as never,
        context,
        new InteractionBroker(),
        {
          id: 'compact-1',
          type: 'action.invoke',
          actionId: SESSION_COMPACT_ACTION_ID,
          input: { customInstructions: 'keep the decisions' },
        },
        remoteControlCapabilitySnapshot,
      ),
    ).resolves.toMatchObject({
      accepted: true,
      actionId: SESSION_COMPACT_ACTION_ID,
    });
    expect(compact).toHaveBeenCalledWith({
      customInstructions: 'keep the decisions',
    });
    expect(completed).toBe(true);
  });

  it('propagates a compact failure instead of acknowledging it', async () => {
    const context = {
      compact: vi.fn(async () => {
        throw new Error('compaction failed');
      }),
      isIdle: () => true,
    } as never;
    await expect(
      dispatchDashboardCommand(
        {} as never,
        context,
        new InteractionBroker(),
        {
          id: 'compact-failure',
          type: 'action.invoke',
          actionId: SESSION_COMPACT_ACTION_ID,
          input: {},
        },
        remoteControlCapabilitySnapshot,
      ),
    ).rejects.toThrow('compaction failed');
  });
});
