import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadLoginEnvironment,
  RUNTIME_HOST_MAX_LINE_BYTES,
  RuntimeHostClient,
  RuntimeHostService,
} from './runtime-host.js';

const testEnvironment = async (): Promise<NodeJS.ProcessEnv> => ({
  ...process.env,
});

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for runtime host child.');
}

describe('runtime host', () => {
  it('loads exported variables after shell startup output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-shell-env-'));
    const shell = path.join(root, 'login-shell');
    await writeFile(
      shell,
      "#!/bin/sh\nprintf 'startup output\\n\\0__PI_RUNTIME_ENV_START__\\0CUSTOM_RUNTIME_VALUE=from-shell\\0PATH=/shell/bin\\0invalid-key=ignored\\0'\n",
    );
    await chmod(shell, 0o700);
    try {
      const environment = await loadLoginEnvironment(root, shell);
      expect(environment.CUSTOM_RUNTIME_VALUE).toBe('from-shell');
      expect(environment.PATH).toBe('/shell/bin');
      expect(environment['invalid-key']).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prewarms the login environment for the host working directory', async () => {
    let loads = 0;
    const service = new RuntimeHostService(
      path.join(os.tmpdir(), 'unused-runtime-host.sock'),
      async () => {
        loads += 1;
        return { ...process.env };
      },
    );
    expect(loads).toBe(1);
    await service.close();
  });

  it('owns headless RPC children, drains UI requests, and makes start idempotent', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'dashboard-runtime-host-'),
    );
    const socket = path.join(root, 'host.sock');
    const marker = path.join(root, 'cancelled');
    const started = path.join(root, 'started');
    const executable = path.join(root, 'fake-pi.mjs');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(started)}, 'start\\n');\nprocess.stdout.write(JSON.stringify({type:'extension_ui_request',id:'request-1'})+'\\n');\nlet buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { buffer += value; let newline; while ((newline=buffer.indexOf('\\n')) >= 0) { const line=buffer.slice(0,newline); buffer=buffer.slice(newline+1); const request=JSON.parse(line); if (request.type === 'get_state') process.stdout.write(JSON.stringify({id:request.id,type:'response',command:'get_state',success:true,data:{}})+'\\n'); if (request.cancelled) fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); }}); setInterval(() => {}, 1000);\n`,
    );
    await chmod(executable, 0o700);
    const environmentLoads: string[] = [];
    const service = new RuntimeHostService(socket, async (cwd) => {
      environmentLoads.push(cwd);
      return testEnvironment();
    });
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
      const [first, second] = await Promise.all([
        client.start(input),
        client.start(input),
      ]);
      expect(second).toEqual(first);
      expect(await readFile(started, 'utf8')).toBe('start\n');
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

      await client.start({ ...input, runtimeId: 'runtime-same-cwd' });
      await client.stop('runtime-same-cwd');

      const otherCwd = path.join(root, 'other-cwd');
      await mkdir(otherCwd);
      await client.start({
        ...input,
        runtimeId: 'runtime-2',
        cwd: otherCwd,
      });
      await client.stop('runtime-2');
      expect(environmentLoads.filter((cwd) => cwd === root)).toHaveLength(1);
      expect(environmentLoads.filter((cwd) => cwd === otherCwd)).toHaveLength(
        1,
      );
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
    const executable = path.join(root, 'exit-pi.mjs');
    // The descendant inherits stdout. The watchdog must terminate the whole
    // process group after the leader exits or Node will never observe close.
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\nlet buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { buffer += value; const newline=buffer.indexOf('\\n'); if (newline < 0) return; const request=JSON.parse(buffer.slice(0,newline)); process.stdout.write(JSON.stringify({id:request.id,type:'response',command:'get_state',success:true,data:{}})+'\\n'); spawn('sleep',['60'],{stdio:'inherit'}); setTimeout(() => process.exit(7), 20); });\n`,
    );
    await chmod(executable, 0o700);
    const service = new RuntimeHostService(socket, testEnvironment);
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

  it('contains malformed clients and child stdin errors', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'dashboard-runtime-host-errors-'),
    );
    const socket = path.join(root, 'host.sock');
    const executable = path.join(root, 'closed-stdin-pi.mjs');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nlet buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { buffer += value; const newline=buffer.indexOf('\\n'); if (newline < 0) return; const request=JSON.parse(buffer.slice(0,newline)); process.stdout.write(JSON.stringify({id:request.id,type:'response',command:'get_state',success:true,data:{}})+'\\n'); process.stdin.destroy(); setTimeout(() => process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'closed-input'})+'\\n'), 20); }); setInterval(() => {}, 1000);\n`,
    );
    await chmod(executable, 0o700);
    const service = new RuntimeHostService(socket, testEnvironment);
    await service.listen();
    const client = new RuntimeHostClient(socket);
    try {
      await client.start({
        runtimeId: 'runtime-errors',
        cwd: root,
        socketPath: path.join(root, 'bridge.sock'),
        launchToken: 'launch',
        identityToken: 'identity',
        piExecutable: executable,
      });
      await new Promise<void>((resolve) => {
        const connection = createConnection(socket);
        connection.once('connect', () =>
          connection.write('x'.repeat(RUNTIME_HOST_MAX_LINE_BYTES + 1)),
        );
        connection.once('close', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await client.list()).toHaveLength(1);
      expect((await client.inspect('runtime-errors'))?.status).toBe('running');
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
    const service = new RuntimeHostService(socket, testEnvironment);
    const second = new RuntimeHostService(socket, testEnvironment);
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
