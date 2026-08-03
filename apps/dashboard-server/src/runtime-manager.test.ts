import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MetadataStore } from './metadata.js';
import { RuntimeManager } from './runtime-manager.js';

describe('runtime stopping', () => {
  it('forgets an external runtime even when its stale bridge rejects shutdown', async () => {
    const forget = vi.fn();
    const manager = new RuntimeManager(
      {
        get: () => ({
          runtimeId: 'external-1',
          ownership: 'external',
          pid: 1,
          cwd: '/tmp',
          liveState: 'idle',
          session: { id: 'ghost-session', entries: [] },
          pendingInteractions: [],
        }),
        sendCommand: async () => {
          throw new Error('This extension ctx is stale.');
        },
        forget,
      } as never,
      {} as never,
      {} as never,
      { managedLaunches: () => [] } as never,
      '/tmp/bridge.sock',
    );
    await expect(manager.stop('external-1')).resolves.toBeUndefined();
    expect(forget).toHaveBeenCalledWith('external-1');
  });
});

describe('managed runtime credentials', () => {
  it('restores placement credentials and separates one-time launch from identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-meta-'));
    const metadata = new MetadataStore(path.join(root, 'dashboard.sqlite'));
    metadata.recordManagedLaunch(
      'runtime-1',
      'workspace-1',
      { tmuxSession: 's', tmuxWindowId: '@1', tmuxPaneId: '%1' },
      { launchToken: 'launch-secret', identityToken: 'identity-secret' },
    );
    const manager = new RuntimeManager(
      {} as never,
      {} as never,
      {} as never,
      metadata,
      '/tmp/bridge.sock',
    );
    expect(manager.placement('runtime-1')).toMatchObject({
      tmuxWindowId: '@1',
    });
    expect(manager.expectedToken('runtime-1', 'launch-secret', undefined)).toBe(
      true,
    );
    expect(manager.expectedToken('runtime-1', 'launch-secret', undefined)).toBe(
      false,
    );
    expect(
      manager.expectedToken('runtime-1', undefined, 'identity-secret'),
    ).toBe(true);
    metadata.close();
    await rm(root, { recursive: true, force: true });
  });
});
