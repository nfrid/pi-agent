import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
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
  const _workspace = (root: string) => ({
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

  it('launches a persisted checkout without a Sesh workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-project-'));
    const start = vi.fn(async ({ runtimeId }: { runtimeId: string }) =>
      binding(runtimeId),
    );
    const recordManagedLaunch = vi.fn();
    const project = { id: 'project-1', status: 'active' };
    const checkout = {
      id: 'checkout-1',
      projectId: project.id,
      path: root,
      status: 'ready',
    };
    const manager = new RuntimeManager(
      { snapshots: () => [] } as never,
      { start } as never,
      {} as never,
      { managedLaunches: () => [], recordManagedLaunch } as never,
      '/tmp/bridge.sock',
      {
        getProject: (id: string) => (id === project.id ? project : undefined),
        getCheckout: (id: string) =>
          id === checkout.id ? checkout : undefined,
      } as never,
    );

    await expect(
      manager.launch({ projectId: project.id, checkoutId: checkout.id }),
    ).resolves.toMatchObject({ runtimeId: expect.any(String) });
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      cwd: await realpath(root),
    });
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty('workspace');
    expect(recordManagedLaunch).toHaveBeenCalledWith(
      expect.any(String),
      {
        projectId: project.id,
        checkoutId: checkout.id,
        cwd: await realpath(root),
      },
      expect.objectContaining({ id: expect.stringMatching(/^runtime-host:/) }),
      expect.objectContaining({ mode: 'write' }),
    );

    await expect(
      manager.launch({
        projectId: project.id,
        checkoutId: checkout.id,
        checkoutCwd: path.dirname(root),
      }),
    ).rejects.toThrow('outside the selected checkout');
    await rm(root, { recursive: true, force: true });
  });

  it('restores and restarts a persisted project launch without Sesh', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-runtime-project-restart-'),
    );
    const metadata = new MetadataStore(path.join(root, 'dashboard.sqlite'));
    const checkoutRoot = path.join(root, 'checkout');
    await mkdir(checkoutRoot);
    const { project, checkout } =
      metadata.orchestration.createProjectWithCheckout(
        {
          id: 'project-restored',
          title: 'Restored',
          rootPath: checkoutRoot,
          defaultIsolation: 'main',
        },
        {
          id: 'checkout-restored',
          kind: 'main',
          path: checkoutRoot,
          status: 'ready',
        },
      );
    const runtimeId = 'runtime-project-restored';
    metadata.recordManagedLaunch(
      runtimeId,
      {
        projectId: project.id,
        checkoutId: checkout.id,
        cwd: checkoutRoot,
      },
      { id: `runtime-host:${runtimeId}` },
      {
        launchToken: 'launch-secret',
        identityToken: 'identity-secret',
        mode: 'read',
      },
    );
    const snapshot = {
      ...runtime('session-project-restored'),
      runtimeId,
      cwd: checkoutRoot,
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
      { get: () => undefined } as never,
      metadata,
      '/tmp/bridge.sock',
      metadata.orchestration,
    );

    await manager.restart(runtimeId);

    expect(start.mock.calls[0]?.[0]).toMatchObject({
      cwd: await realpath(checkoutRoot),
      mode: 'read',
    });
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty('workspace');
    metadata.close();
    await rm(root, { recursive: true, force: true });
  });
});

describe('managed runtime credentials', () => {
  it('restores placement credentials and separates one-time launch from identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-runtime-meta-'));
    const metadata = new MetadataStore(path.join(root, 'dashboard.sqlite'));
    metadata.recordManagedLaunch(
      'runtime-1',
      { projectId: 'project-1', checkoutId: 'checkout-1', cwd: '/tmp' },
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
