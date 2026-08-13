import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeSnapshot, WorkspaceTarget } from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import { MetadataStore } from './metadata.js';
import { RuntimeManager } from './runtime-manager.js';

describe('runtime stopping', () => {
  it('stops the exact restored opaque binding once when hello never arrives', async () => {
    const restoredBinding = {
      runtimeId: 'runtime-restored-opaque',
      location: { id: 'provider:opaque-restored-location' },
    };
    const stop = vi.fn().mockResolvedValue(undefined);
    const markManagedStopped = vi.fn();
    const forget = vi.fn();
    const manager = new RuntimeManager(
      { forget } as never,
      {
        attach: vi.fn().mockResolvedValue(restoredBinding),
        stop,
      } as never,
      {} as never,
      {
        managedLaunches: () => [
          {
            runtimeId: restoredBinding.runtimeId,
            workspaceId: 'workspace-restored',
            placement: {
              tmuxSession: 'sesh',
              tmuxWindowId: '@restored',
              tmuxPaneId: '%restored',
              displayTarget: 'sesh:@restored',
            },
            identityTokenHash: 'identity-hash',
            launchTokenHash: 'launch-hash',
            launchConsumed: true,
            launchedAt: 1,
          },
        ],
        markManagedStopped,
      } as never,
      '/tmp/bridge.sock',
    );
    await expect(manager.recover(restoredBinding.runtimeId)).resolves.toBe(
      true,
    );
    await manager.stopRecovered(restoredBinding.runtimeId);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(restoredBinding);
    expect(markManagedStopped).toHaveBeenCalledOnce();
    expect(markManagedStopped).toHaveBeenCalledWith(restoredBinding.runtimeId);
    expect(forget).toHaveBeenCalledOnce();
  });

  it('retains recovered evidence when provider cleanup fails and retries it', async () => {
    const restoredBinding = {
      runtimeId: 'runtime-recovered-retry',
      location: { id: 'provider:opaque-retry-location' },
    };
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider stop failed'))
      .mockResolvedValue(undefined);
    const forget = vi.fn();
    const manager = new RuntimeManager(
      { forget } as never,
      {
        attach: vi.fn().mockResolvedValue(restoredBinding),
        stop,
      } as never,
      {} as never,
      {
        managedLaunches: () => [
          {
            runtimeId: restoredBinding.runtimeId,
            workspaceId: 'workspace-retry',
            placement: {
              tmuxSession: 'sesh',
              tmuxWindowId: '@retry',
              tmuxPaneId: '%retry',
            },
            identityTokenHash: 'identity-hash',
            launchTokenHash: 'launch-hash',
            launchConsumed: true,
            launchedAt: 1,
          },
        ],
        markManagedStopped: vi.fn(),
      } as never,
      '/tmp/bridge.sock',
    );
    await manager.recover(restoredBinding.runtimeId);
    await expect(
      manager.stopRecovered(restoredBinding.runtimeId),
    ).rejects.toThrow('provider stop failed');
    expect(manager.placement(restoredBinding.runtimeId)).toBeDefined();
    expect(forget).not.toHaveBeenCalled();
    await manager.stopRecovered(restoredBinding.runtimeId);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(forget).toHaveBeenCalledOnce();
  });

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

describe('managed runtime launch safety', () => {
  const workspace = (root: string): WorkspaceTarget => ({
    id: 'workspace-1',
    name: 'Workspace',
    path: root,
    canonicalPath: root,
    source: 'directory',
    tmuxSession: 'sesh',
    active: true,
  });

  const runtime = (sessionId: string): RuntimeSnapshot => ({
    runtimeId: 'runtime-active',
    ownership: 'managed',
    pid: 10,
    cwd: '/other',
    liveState: 'idle',
    session: { id: sessionId, entries: [] },
    pendingInteractions: [],
  });
  const binding = (runtimeId: string) => ({
    runtimeId,
    location: {
      id: `${runtimeId}:location`,
      sessionId: 'sesh',
      windowId: '@1',
      paneId: '%1',
      displayTarget: 'sesh:@1',
    },
  });

  it('rejects resuming a session already owned by an active runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-active-'));
    const sessionFile = path.join(root, 'session.jsonl');
    await writeFile(sessionFile, '{}\n');
    const newManagedWindow = vi.fn();
    const registry = {
      snapshots: () => [runtime('session-1')],
    };
    const sessions = { get: () => ({ id: 'session-1', file: sessionFile }) };
    const manager = new RuntimeManager(
      registry as never,
      { start: newManagedWindow } as never,
      sessions as never,
      { managedLaunches: () => [] } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);
    await expect(
      manager.launch({ workspaceId: 'workspace-1', sessionId: 'session-1' }),
    ).rejects.toThrow('already active');
    expect(newManagedWindow).not.toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
  });

  it('allows concurrent launches sharing a checkout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-shared-'));
    const start = vi.fn(async ({ runtimeId }: { runtimeId: string }) =>
      binding(runtimeId),
    );
    const manager = new RuntimeManager(
      {
        snapshots: () => [{ ...runtime('existing'), cwd: root, online: true }],
      } as never,
      { start } as never,
      {} as never,
      {
        managedLaunches: () => [],
        recordManagedLaunch: vi.fn(),
      } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);

    await expect(
      manager.launch({ workspaceId: 'workspace-1' }),
    ).resolves.toMatchObject({ runtimeId: expect.any(String) });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      cwd: await realpath(root),
    });
    await rm(root, { recursive: true, force: true });
  });

  it('delivers an initial prompt even if hello races tmux launch completion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-prompt-'));
    const sendCommand = vi.fn().mockResolvedValue({ accepted: true });
    let manager!: RuntimeManager;
    const registry = {
      snapshots: () => [],
      sendCommand,
    };
    const runtimeSnapshot = runtime('new-session');
    const provider = {
      start: async ({ runtimeId }: { runtimeId: string }) => {
        manager.onRegistryChange({
          kind: 'registered',
          snapshot: { ...runtimeSnapshot, runtimeId },
        });
        return binding(runtimeId);
      },
    };
    manager = new RuntimeManager(
      registry as never,
      provider as never,
      {} as never,
      {
        managedLaunches: () => [],
        recordManagedLaunch: vi.fn(),
      } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);
    await manager.launch({
      workspaceId: 'workspace-1',
      initialPrompt: 'start here',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendCommand).toHaveBeenCalledOnce();
    expect(sendCommand.mock.calls[0]?.[0]).toMatch(/^runtime-/);
    expect(sendCommand.mock.calls[0]?.[1]).toEqual({
      type: 'prompt',
      text: 'start here',
    });
    await rm(root, { recursive: true, force: true });
  });

  it('launches and stops a provider with an opaque location', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-opaque-'));
    let launchedBinding!: {
      runtimeId: string;
      location: { id: string };
    };
    const stop = vi.fn().mockResolvedValue(undefined);
    const recordManagedLaunch = vi.fn();
    let launchedRuntimeId = '';
    const snapshot = {
      runtimeId: 'runtime-opaque',
      ownership: 'managed' as const,
      pid: 0,
      cwd: '/other',
      liveState: 'idle' as const,
      session: { id: 'opaque-session', entries: [] },
      pendingInteractions: [],
    };
    const registry = {
      snapshots: () => [],
      get: (id: string) =>
        id === launchedRuntimeId ? { ...snapshot, runtimeId: id } : undefined,
      sendCommand: vi.fn().mockResolvedValue(undefined),
      isOnline: () => false,
      forget: vi.fn(),
    };
    const provider = {
      start: async ({ runtimeId: id }: { runtimeId: string }) => {
        launchedRuntimeId = id;
        launchedBinding = { runtimeId: id, location: { id: 'opaque:abc' } };
        return launchedBinding;
      },
      stop,
    };
    const manager = new RuntimeManager(
      registry as never,
      provider as never,
      { get: () => undefined } as never,
      {
        managedLaunches: () => [],
        recordManagedLaunch,
      } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([
      {
        ...workspace(root),
        tmuxSession: undefined,
        active: false,
      },
    ]);

    const result = await manager.launch({ workspaceId: 'workspace-1' });
    expect(result).toEqual({ runtimeId: expect.any(String) });
    expect(result.placement).toBeUndefined();
    expect(recordManagedLaunch).not.toHaveBeenCalled();

    await manager.stop(result.runtimeId);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(launchedBinding);
    await rm(root, { recursive: true, force: true });
  });

  it('does not resend an initial prompt after an acknowledgement loss', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-once-'));
    const sendCommand = vi
      .fn()
      .mockRejectedValue(new Error('acknowledgement lost'));
    let runtimeId = '';
    const manager = new RuntimeManager(
      {
        snapshots: () => [],
        sendCommand,
      } as never,
      {
        start: async ({ runtimeId: id }: { runtimeId: string }) => {
          runtimeId = id;
          return binding(id);
        },
      } as never,
      {} as never,
      {
        managedLaunches: () => [],
        recordManagedLaunch: vi.fn(),
      } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);
    await manager.launch({
      workspaceId: 'workspace-1',
      initialPrompt: 'run once',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    manager.onRegistryChange({
      kind: 'registered',
      snapshot: { ...runtime('reconnected'), runtimeId },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendCommand).toHaveBeenCalledOnce();
    await rm(root, { recursive: true, force: true });
  });

  it('preserves restored read mode and isolated cwd when restarting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-restart-'));
    const checkout = path.join(root, 'isolated-checkout');
    await mkdir(checkout, { recursive: true });
    const sessionFile = path.join(root, 'session.jsonl');
    await writeFile(sessionFile, '{}\n');
    const runtimeId = 'runtime-restored-read';
    const snapshot = {
      ...runtime('session-restored'),
      runtimeId,
      cwd: checkout,
    };
    const start = vi.fn(async ({ runtimeId: nextId }: { runtimeId: string }) =>
      binding(nextId),
    );
    const manager = new RuntimeManager(
      {
        get: (id: string) => (id === runtimeId ? snapshot : undefined),
        snapshots: () => [],
        isOnline: () => false,
        forget: vi.fn(),
      } as never,
      { start, stop: vi.fn().mockResolvedValue(undefined) } as never,
      {
        get: (id: string) =>
          id === snapshot.session.id
            ? { id, file: sessionFile, cwd: checkout }
            : undefined,
      } as never,
      {
        managedLaunches: () => [
          {
            runtimeId,
            workspaceId: 'workspace-1',
            placement: {
              tmuxSession: 'sesh',
              tmuxWindowId: '@1',
              tmuxPaneId: '%1',
              displayTarget: 'sesh:@1',
            },
            mode: 'read',
            identityTokenHash: 'identity-hash',
            launchTokenHash: 'launch-hash',
            launchConsumed: true,
            launchedAt: 1,
          },
        ],
        markManagedStopped: vi.fn(),
        recordManagedLaunch: vi.fn(),
      } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);

    await manager.restart(runtimeId);

    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      cwd: await realpath(checkout),
      mode: 'read',
    });
    await rm(root, { recursive: true, force: true });
  });

  it('rolls back the tmux window if metadata persistence fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-rollback-'));
    const placement = {
      tmuxSession: 'sesh',
      tmuxWindowId: '@1',
      tmuxPaneId: '%1',
      displayTarget: 'sesh:@1',
    };
    const stop = vi.fn().mockResolvedValue(undefined);
    const metadata = {
      managedLaunches: () => [],
      recordManagedLaunch: () => {
        throw new Error('disk full');
      },
    };
    const manager = new RuntimeManager(
      { snapshots: () => [] } as never,
      {
        start: async ({ runtimeId }: { runtimeId: string }) => ({
          runtimeId,
          location: {
            id: `${runtimeId}:location`,
            sessionId: placement.tmuxSession,
            windowId: placement.tmuxWindowId,
            paneId: placement.tmuxPaneId,
            displayTarget: placement.displayTarget,
          },
        }),
        stop,
      } as never,
      {} as never,
      metadata as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);
    await expect(
      manager.launch({ workspaceId: 'workspace-1' }),
    ).rejects.toThrow('disk full');
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.calls[0]?.[0]).toMatchObject({
      location: {
        sessionId: placement.tmuxSession,
        windowId: placement.tmuxWindowId,
        paneId: placement.tmuxPaneId,
      },
    });
    await rm(root, { recursive: true, force: true });
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
