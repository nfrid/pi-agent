import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeHostClient, RuntimeHostService } from './runtime-host.js';

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for runtime host child.');
}

describe('runtime host', () => {
  it('owns headless RPC children, drains UI requests, and makes start idempotent', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'dashboard-runtime-host-'),
    );
    const socket = path.join(root, 'host.sock');
    const marker = path.join(root, 'cancelled');
    const executable = path.join(root, 'fake-pi.mjs');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nprocess.stdout.write(JSON.stringify({type:'extension_ui_request',id:'request-1'})+'\\n');\nprocess.stdin.setEncoding('utf8'); process.stdin.on('data', value => { if (value.includes('cancelled')) fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); }); setInterval(() => {}, 1000);\n`,
    );
    await chmod(executable, 0o700);
    const service = new RuntimeHostService(socket);
    await service.listen();
    const client = new RuntimeHostClient(socket);
    const input = {
      runtimeId: 'runtime-1',
      cwd: root,
      name: 'managed',
      mode: 'read' as const,
      socketPath: path.join(root, 'bridge.sock'),
      launchToken: 'launch',
      identityToken: 'identity',
      piExecutable: executable,
    };
    try {
      const first = await client.start(input);
      const second = await client.start(input);
      expect(second).toEqual(first);
      expect((await client.inspect('runtime-1'))?.args).toEqual([
        '--mode',
        'rpc',
        '--approve',
        '--tools',
        'read,grep,find,ls',
        '--name',
        'managed',
      ]);
      await eventually(async () => {
        try {
          return (await readFile(marker, 'utf8')) === 'yes';
        } catch {
          return false;
        }
      });
      await expect(
        client.start({ ...input, launchToken: 'other-launch' }),
      ).rejects.toThrow('different launch');
      if (!first.location) throw new Error('Missing runtime host location.');
      await client.attach({ runtimeId: 'runtime-1', location: first.location });
      await client.stop('runtime-1');
      await client.stop('runtime-1');
      expect((await client.inspect('runtime-1'))?.status).toBe('stopped');
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports natural child exit without stopping the host', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'dashboard-runtime-host-exit-'),
    );
    const socket = path.join(root, 'host.sock');
    const executable = path.join(root, 'exit-pi.sh');
    await writeFile(executable, '#!/bin/sh\nexit 7\n');
    await chmod(executable, 0o700);
    const service = new RuntimeHostService(socket);
    await service.listen();
    const client = new RuntimeHostClient(socket);
    try {
      await client.start({
        runtimeId: 'runtime-exit',
        cwd: root,
        socketPath: path.join(root, 'bridge.sock'),
        launchToken: 'launch',
        identityToken: 'identity',
        piExecutable: executable,
      });
      await eventually(
        async () =>
          (await client.inspect('runtime-exit'))?.status === 'stopped',
      );
      expect(await client.list()).toHaveLength(1);
      expect(await client.inspect('runtime-exit')).toMatchObject({
        status: 'stopped',
        exitCode: 7,
      });
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a second host and rejects an executable that cannot spawn', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'dashboard-runtime-host-owner-'),
    );
    const socket = path.join(root, 'host.sock');
    const service = new RuntimeHostService(socket);
    const second = new RuntimeHostService(socket);
    await service.listen();
    try {
      await expect(second.listen()).rejects.toThrow('already running');
      const client = new RuntimeHostClient(socket);
      await expect(
        client.start({
          runtimeId: 'runtime-missing',
          cwd: root,
          socketPath: path.join(root, 'bridge.sock'),
          launchToken: 'launch',
          identityToken: 'identity',
          piExecutable: path.join(root, 'missing-pi'),
        }),
      ).rejects.toThrow();
      expect(await client.inspect('runtime-missing')).toBeUndefined();
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
