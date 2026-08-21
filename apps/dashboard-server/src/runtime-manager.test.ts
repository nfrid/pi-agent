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
            location: { id: 'provider:opaque-restored-location' },
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
            location: { id: 'provider:opaque-retry-location' },
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
    expect(manager.location(restoredBinding.runtimeId)).toBeDefined();
    expect(forget).not.toHaveBeenCalled();
    await manager.stopRecovered(restoredBinding.runtimeId);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(forget).toHaveBeenCalledOnce();
  });

  it('retains recovery evidence when the sidecar is unavailable', async () => {
    const runtimeId = 'runtime-sidecar-unavailable';
    const markManagedStopped = vi.fn();
    const manager = new RuntimeManager(
      {} as never,
      {
        attach: vi.fn().mockRejectedValue(new Error('host unavailable')),
        stop: vi.fn().mockRejectedValue(new Error('host unavailable')),
      } as never,
      {} as never,
      {
        managedLaunches: () => [
          {
            runtimeId,
            workspaceId: 'workspace-sidecar',
            location: { id: `runtime-host:${runtimeId}` },
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

    await expect(manager.recover(runtimeId)).resolves.toBe(false);
    expect(manager.location(runtimeId)).toEqual({
      id: `runtime-host:${runtimeId}`,
    });
    expect(markManagedStopped).not.toHaveBeenCalled();
  });

  it('retains recovery evidence when tombstoning fails after cleanup', async () => {
    const runtimeId = 'runtime-tombstone-retry';
    const stop = vi.fn().mockResolvedValue(undefined);
    const manager = new RuntimeManager(
      {} as never,
      {
        attach: vi.fn().mockRejectedValue(new Error('runtime absent')),
        stop,
      } as never,
      {} as never,
      {
        managedLaunches: () => [
          {
            runtimeId,
            workspaceId: 'workspace-tombstone',
            location: { id: `runtime-host:${runtimeId}` },
            identityTokenHash: 'identity-hash',
            launchTokenHash: 'launch-hash',
            launchConsumed: true,
            launchedAt: 1,
          },
        ],
        markManagedStopped: vi.fn(() => {
          throw new Error('database unavailable');
        }),
      } as never,
      '/tmp/bridge.sock',
    );

    await expect(manager.recover(runtimeId)).resolves.toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(manager.location(runtimeId)).toEqual({
      id: `runtime-host:${runtimeId}`,
    });
  });

  it('gives managed shutdown a bounded command grace before provider cleanup', async () => {
    const runtimeId = 'runtime-managed-stop';
    let acknowledge!: () => void;
    const sendCommand = vi.fn(
      () =>
        new Promise<{ accepted: true }>((resolve) => {
          acknowledge = () => resolve({ accepted: true });
        }),
    );
    const isOnline = vi.fn(() => true);
    const stop = vi.fn().mockResolvedValue(undefined);
    const forget = vi.fn();
    const manager = new RuntimeManager(
      {
        get: () => ({
          runtimeId,
          ownership: 'managed',
          pid: 10,
          cwd: '/tmp',
          liveState: 'idle',
          session: { id: 'managed-session', entries: [] },
        }),
        sendCommand,
        isOnline,
        forget,
      } as never,
      { stop } as never,
      {} as never,
      {
        managedLaunches: () => [
          {
            runtimeId,
            workspaceId: 'workspace-managed',
            location: { id: `runtime-host:${runtimeId}` },
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

    const stopping = manager.stop(runtimeId);
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    acknowledge();
    await stopping;
    expect(sendCommand).toHaveBeenCalledWith(runtimeId, { type: 'shutdown' });
    expect(stop).toHaveBeenCalledOnce();
    expect(isOnline).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledWith(runtimeId);
  });

  it('caps managed shutdown command grace when acknowledgement never arrives', async () => {
    vi.useFakeTimers();
    try {
      const runtimeId = 'runtime-managed-timeout';
      const stop = vi.fn().mockResolvedValue(undefined);
      const manager = new RuntimeManager(
        {
          get: () => ({
            runtimeId,
            ownership: 'managed',
            pid: 10,
            cwd: '/tmp',
            liveState: 'idle',
            session: { id: 'managed-session', entries: [] },
          }),
          sendCommand: () => new Promise<never>(() => undefined),
          forget: vi.fn(),
        } as never,
        { stop } as never,
        {} as never,
        {
          managedLaunches: () => [
            {
              runtimeId,
              workspaceId: 'workspace-managed',
              location: { id: `runtime-host:${runtimeId}` },
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

      const stopping = manager.stop(runtimeId);
      await vi.advanceTimersByTimeAsync(499);
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
  });
  const binding = (runtimeId: string) => ({
    runtimeId,
    location: {
      id: `runtime-host:${runtimeId}`,
      displayTarget: `runtime-host://${runtimeId}`,
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
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty('name');
    await rm(root, { recursive: true, force: true });
  });

  it('rejects concurrent launches for the same explicit runtime identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-same-id-'));
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const start = vi.fn(async ({ runtimeId }: { runtimeId: string }) => {
      await startGate;
      return binding(runtimeId);
    });
    const recordManagedLaunch = vi.fn();
    const manager = new RuntimeManager(
      { snapshots: () => [] } as never,
      { start } as never,
      {} as never,
      { managedLaunches: () => [], recordManagedLaunch } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);

    const first = manager.launch({
      workspaceId: 'workspace-1',
      runtimeId: 'runtime-explicit',
    });
    await expect(
      manager.launch({
        workspaceId: 'workspace-1',
        runtimeId: 'runtime-explicit',
      }),
    ).rejects.toThrow('already active');
    releaseStart();
    await expect(first).resolves.toEqual({ runtimeId: 'runtime-explicit' });
    expect(start).toHaveBeenCalledOnce();
    expect(recordManagedLaunch).toHaveBeenCalledOnce();
    await rm(root, { recursive: true, force: true });
  });

  it('delivers an initial prompt even if hello races host launch completion', async () => {
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

  it('waits for a required bridge registration before launch succeeds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-hello-'));
    let runtimeId = '';
    const registry = {
      snapshots: () => [],
      get: vi.fn(() =>
        registry.get.mock.calls.length > 1
          ? { ...runtime('hello-session'), runtimeId, online: true }
          : undefined,
      ),
    };
    const manager = new RuntimeManager(
      registry as never,
      {
        requiresRegistration: true,
        start: vi.fn(async ({ runtimeId: id }: { runtimeId: string }) => {
          runtimeId = id;
          return binding(id);
        }),
      } as never,
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
    expect(registry.get).toHaveBeenCalledTimes(2);
    await rm(root, { recursive: true, force: true });
  });

  it('stops and tombstones a host that never registers its bridge', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-no-hello-'));
    const stop = vi.fn().mockResolvedValue(undefined);
    const markManagedStopped = vi.fn();
    try {
      const manager = new RuntimeManager(
        { snapshots: () => [], get: () => undefined } as never,
        {
          requiresRegistration: true,
          start: vi.fn(async ({ runtimeId }: { runtimeId: string }) =>
            binding(runtimeId),
          ),
          stop,
        } as never,
        {} as never,
        {
          managedLaunches: () => [],
          recordManagedLaunch: vi.fn(),
          markManagedStopped,
        } as never,
        '/tmp/bridge.sock',
      );
      manager.setWorkspaces([workspace(root)]);

      const launch = expect(
        manager.launch({ workspaceId: 'workspace-1' }),
      ).rejects.toThrow('did not connect');
      await vi.advanceTimersByTimeAsync(10_100);
      await launch;
      expect(stop).toHaveBeenCalledOnce();
      expect(markManagedStopped).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('launches and stops the headless provider with its deterministic location', async () => {
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
        launchedBinding = {
          runtimeId: id,
          location: { id: `runtime-host:${id}` },
        };
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
        markManagedStopped: vi.fn(),
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
    expect(recordManagedLaunch).toHaveBeenCalledOnce();

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
        sendCommand: vi.fn().mockResolvedValue({ accepted: true }),
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
            location: {
              id: 'runtime:location',
              displayTarget: 'runtime://location',
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

  it('does not spawn when metadata persistence fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-rollback-'));
    const start = vi.fn();
    const manager = new RuntimeManager(
      { snapshots: () => [] } as never,
      { start } as never,
      {} as never,
      {
        managedLaunches: () => [],
        recordManagedLaunch: () => {
          throw new Error('disk full');
        },
      } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);
    await expect(
      manager.launch({ workspaceId: 'workspace-1' }),
    ).rejects.toThrow('disk full');
    expect(start).not.toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
  });

  it('retains cleanup evidence but drops prompts when compensation fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-cleanup-'));
    const sendCommand = vi.fn();
    let runtimeId = '';
    const manager = new RuntimeManager(
      { snapshots: () => [], sendCommand } as never,
      {
        start: vi.fn(async ({ runtimeId: id }: { runtimeId: string }) => {
          runtimeId = id;
          throw new Error('response lost');
        }),
        stop: vi.fn().mockRejectedValue(new Error('host unavailable')),
      } as never,
      {} as never,
      {
        managedLaunches: () => [],
        recordManagedLaunch: vi.fn(),
        markManagedStopped: vi.fn(),
      } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);

    await expect(
      manager.launch({
        workspaceId: 'workspace-1',
        initialPrompt: 'must not replay',
      }),
    ).rejects.toThrow('host unavailable');
    expect(runtimeId).toMatch(/^runtime-/);
    expect(manager.hasLaunch(runtimeId)).toBe(true);
    expect(manager.location(runtimeId)?.id).toBe(`runtime-host:${runtimeId}`);
    manager.onRegistryChange({
      kind: 'registered',
      snapshot: { ...runtime('late-session'), runtimeId },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendCommand).not.toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
  });

  it('persists ownership before spawn and tombstones a failed start', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-order-'));
    const events: string[] = [];
    const markManagedStopped = vi.fn(() => events.push('stopped'));
    const stop = vi.fn(async () => events.push('stop'));
    const manager = new RuntimeManager(
      { snapshots: () => [] } as never,
      {
        start: vi.fn(async () => {
          events.push('start');
          throw new Error('spawn failed');
        }),
        stop,
      } as never,
      {} as never,
      {
        managedLaunches: () => [],
        recordManagedLaunch: vi.fn(() => events.push('record')),
        markManagedStopped,
      } as never,
      '/tmp/bridge.sock',
    );
    manager.setWorkspaces([workspace(root)]);
    await expect(
      manager.launch({ workspaceId: 'workspace-1' }),
    ).rejects.toThrow('spawn failed');
    expect(events).toEqual(['record', 'start', 'stop', 'stopped']);
    expect(stop).toHaveBeenCalledWith({
      runtimeId: expect.stringMatching(/^runtime-/),
      location: {
        id: expect.stringMatching(/^runtime-host:runtime-/),
        displayTarget: expect.stringMatching(/^runtime-host:\/\/runtime-/),
      },
    });
    expect(markManagedStopped).toHaveBeenCalledOnce();
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
      { id: 'host:runtime-1', displayTarget: 'runtime-host://runtime-1' },
      { launchToken: 'launch-secret', identityToken: 'identity-secret' },
    );
    const manager = new RuntimeManager(
      {} as never,
      {} as never,
      {} as never,
      metadata,
      '/tmp/bridge.sock',
    );
    expect(manager.location('runtime-1')).toMatchObject({
      id: 'host:runtime-1',
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
