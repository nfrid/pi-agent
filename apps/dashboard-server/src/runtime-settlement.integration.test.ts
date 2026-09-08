import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HeadlessRuntimeProvider } from './headless-runtime-provider.js';
import { MetadataStore } from './metadata.js';
import { RuntimeHostClient, RuntimeHostService } from './runtime-host.js';
import { RuntimeManager } from './runtime-manager.js';

const environment = async (): Promise<NodeJS.ProcessEnv> => ({
  ...process.env,
});

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for runtime process state.');
}

function saveRuntime(
  store: MetadataStore,
  runtimeId: string,
  pid: number,
): void {
  store.saveRuntime({
    runtimeId,
    ownership: 'managed',
    pid,
    cwd: process.cwd(),
    liveState: 'idle',
    session: { id: `session-${runtimeId}`, entries: [] },
    lastSeenAt: Date.now(),
  } as never);
}

describe('restarted runtime settlement integration', () => {
  it('settles an exited child after reopening metadata and restarting an empty host', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'runtime-settlement-integration-'),
    );
    const socket = path.join(root, 'runtime-host.sock');
    const database = path.join(root, 'dashboard.sqlite');
    const executable = path.join(root, 'exiting-pi.mjs');
    const runtimeId = 'runtime-exited-after-restart';
    const service = new RuntimeHostService(socket, environment);
    let reopened: MetadataStore | undefined;
    let restarted: RuntimeHostService | undefined;
    try {
      await writeFile(
        executable,
        `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf('\\n');
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  if (request.type === 'get_state') {
    process.stdout.write(JSON.stringify({ id: request.id, type: 'response', command: 'get_state', success: true, data: {} }) + '\\n');
    setTimeout(() => process.exit(0), 20);
  }
});
`,
      );
      await chmod(executable, 0o700);
      await service.listen();
      const binding = await new RuntimeHostClient(socket).start({
        runtimeId,
        cwd: root,
        socketPath: path.join(root, 'bridge.sock'),
        launchToken: 'launch',
        identityToken: 'identity',
        piExecutable: executable,
      });
      expect(binding.processId).toEqual(expect.any(Number));
      await eventually(() => {
        try {
          process.kill(binding.processId as number, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      });

      const metadata = new MetadataStore(database);
      metadata.recordManagedLaunch(
        runtimeId,
        { cwd: root },
        binding.location ?? { id: `runtime-host:${runtimeId}` },
        { identityToken: 'identity', launchToken: 'launch' },
      );
      saveRuntime(metadata, runtimeId, binding.processId as number);
      await service.close();
      metadata.close();

      restarted = new RuntimeHostService(socket, environment);
      await restarted.listen();
      reopened = new MetadataStore(database);
      const manager = new RuntimeManager(
        { get: vi.fn(), forget: vi.fn() } as never,
        new HeadlessRuntimeProvider(socket),
        {} as never,
        reopened,
        socket,
      );
      await expect(manager.recover(runtimeId)).resolves.toBe(false);
      expect(reopened.managedLaunches()).toEqual([]);
      expect(
        reopened
          .managedLaunchHistory()
          .find((record) => record.runtimeId === runtimeId)?.stoppedAt,
      ).toEqual(expect.any(Number));
      expect(manager.canStop(runtimeId)).toBe(false);
    } finally {
      reopened?.close();
      await restarted?.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a live saved PID and preserves retryable manager metadata', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'runtime-settlement-live-pid-'),
    );
    const socket = path.join(root, 'runtime-host.sock');
    const database = path.join(root, 'dashboard.sqlite');
    const runtimeId = 'runtime-live-after-restart';
    const service = new RuntimeHostService(socket, environment);
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    let metadata: MetadataStore | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      if (!child.pid) throw new Error('Live test child did not expose a PID.');
      metadata = new MetadataStore(database);
      metadata.recordManagedLaunch(
        runtimeId,
        { cwd: root },
        { id: `runtime-host:${runtimeId}` },
        { identityToken: 'identity', launchToken: 'launch' },
      );
      saveRuntime(metadata, runtimeId, child.pid);
      await service.listen();
      const manager = new RuntimeManager(
        { get: vi.fn(), forget: vi.fn() } as never,
        new HeadlessRuntimeProvider(socket),
        {} as never,
        metadata,
        socket,
      );

      await expect(manager.recover(runtimeId)).resolves.toBe(false);
      expect(metadata.managedLaunches()).toEqual([
        expect.objectContaining({ runtimeId, processId: child.pid }),
      ]);
      expect(manager.canStop(runtimeId)).toBe(true);
      expect(
        metadata
          .managedLaunchHistory()
          .find((record) => record.runtimeId === runtimeId)?.stoppedAt,
      ).toBeUndefined();
    } finally {
      child.kill('SIGKILL');
      metadata?.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
