import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MAX_FILE_READ_BYTES } from '@pi-dashboard/protocol';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from './file-read.js';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const TOKEN = 'file-read-token';
const ORIGIN = 'http://dashboard.test';
const apps: ReturnType<typeof Fastify>[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function routeContext(
  fileReader: NonNullable<DashboardRouteContext['readFile']>,
): DashboardRouteContext {
  return {
    token: TOKEN,
    serverId: () => 'file-read-generation',
    origins: () => [ORIGIN],
    snapshot: () => ({
      serverId: 'file-read-generation',
      revision: 1,
      cursor: 1,
      runtimes: [],
      sessions: [],
      unread: [],
    }),
    readFile: fileReader,
    usage: async () => ({ usage: null }),
    readDelegateHistory: async () => ({
      version: 2,
      sessionId: 's',
      groups: [],
    }),
    readDelegateHistoryRun: async () => ({
      version: 1,
      sessionId: 's',
      lineageId: 'l',
      runId: 'r',
      run: {
        runId: 'r',
        lineageId: 'l',
        name: 'run',
        kind: 'background',
        state: 'success',
        createdAt: 1,
        allowWrites: false,
        details: { truncated: false },
      },
    }),
    renameSession: async () => ({}),
    startRuntime: async () => ({}),
    commandRuntime: async () => ({}),
    stopRuntime: async () => undefined,
    markNotificationRead: () => undefined,
    markAllNotificationsRead: () => undefined,
    pushSubscribe: () => undefined,
    vapidPublicKey: () => null,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('host file reads', () => {
  it('reads absolute, relative-with-cwd, and ~/ paths with normalized results', async () => {
    const root = await tempRoot('dashboard-file-read-');
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    const file = path.join(nested, 'note.txt');
    await writeFile(file, 'hello π\n');
    const absolute = await readFile({ path: file });
    expect(absolute).toEqual({
      path: path.resolve(file),
      content: 'hello π\n',
    });
    await expect(readFile({ path: 'note.txt', cwd: nested })).resolves.toEqual(
      absolute,
    );

    const homeRoot = await tempRoot('dashboard-file-read-home-');
    const homeFile = path.join(homeRoot, 'home.txt');
    await writeFile(homeFile, 'home');
    const tildePath = `~/${path.relative(os.homedir(), homeFile)}`;
    await expect(readFile({ path: tildePath })).resolves.toEqual({
      path: path.resolve(homeFile),
      content: 'home',
    });
  });

  it('requires an absolute cwd for relative paths and rejects unsupported path forms', async () => {
    await expect(readFile({ path: 'relative.txt' })).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(
      readFile({ path: 'relative.txt', cwd: 'relative-cwd' }),
    ).rejects.toMatchObject({ code: 'invalid-path' });
    await expect(readFile({ path: '~other/file.txt' })).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(readFile({ path: '/tmp/\0file' })).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(
      readFile({ path: 'file', cwd: '/tmp/\0cwd' }),
    ).rejects.toMatchObject({
      code: 'invalid-path',
    });
  });

  it('reports missing, permission, and non-regular files clearly', async () => {
    const root = await tempRoot('dashboard-file-read-errors-');
    await expect(
      readFile({ path: path.join(root, 'missing.txt') }),
    ).rejects.toThrow('File not found.');
    await mkdir(path.join(root, 'directory'));
    await expect(
      readFile({ path: path.join(root, 'directory') }),
    ).rejects.toThrow('Only regular files can be read.');

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const denied = path.join(root, 'denied.txt');
      await writeFile(denied, 'denied');
      await chmod(denied, 0o000);
      try {
        await expect(readFile({ path: denied })).rejects.toThrow(
          'Permission denied',
        );
      } finally {
        await chmod(denied, 0o600);
      }
    }
  });

  it('rejects oversized, binary, invalid UTF-8, and FIFO inputs without blocking', async () => {
    const root = await tempRoot('dashboard-file-read-bounds-');
    const large = path.join(root, 'large.txt');
    await writeFile(large, Buffer.alloc(MAX_FILE_READ_BYTES + 1, 0x61));
    await expect(readFile({ path: large })).rejects.toThrow('too large');

    const atLimit = path.join(root, 'at-limit.txt');
    await writeFile(atLimit, 'π'.repeat(MAX_FILE_READ_BYTES / 2));
    await expect(readFile({ path: atLimit })).resolves.toMatchObject({
      content: 'π'.repeat(MAX_FILE_READ_BYTES / 2),
    });

    const binary = path.join(root, 'binary');
    await writeFile(binary, Buffer.from([0, 1, 2, 3]));
    await expect(readFile({ path: binary })).rejects.toThrow('binary');
    const invalidUtf8 = path.join(root, 'invalid-utf8');
    await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe]));
    await expect(readFile({ path: invalidUtf8 })).rejects.toThrow('binary');

    if (process.platform !== 'win32') {
      const fifo = path.join(root, 'pipe');
      await execFile('mkfifo', [fifo]);
      await expect(readFile({ path: fifo })).rejects.toThrow(
        'Only regular files can be read.',
      );
    }
  });

  it('serves file reads through the authenticated, origin-checked protocol-v3 boundary', async () => {
    const root = await tempRoot('dashboard-file-read-route-');
    const file = path.join(root, 'route.txt');
    await writeFile(file, 'route content');
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, {
      context: routeContext(readFile),
    });
    await app.ready();

    const headers = {
      origin: ORIGIN,
      'x-dashboard-token': TOKEN,
      'x-dashboard-protocol-version': '3',
      'content-type': 'application/json',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/readFile',
      headers,
      payload: { path: file },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.data).toEqual({
      path: path.resolve(file),
      content: 'route content',
    });

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/trpc/readFile',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { path: file },
    });
    expect(unauthorized.statusCode).toBe(401);

    const { origin: _origin, ...originlessHeaders } = headers;
    for (const deniedHeaders of [
      originlessHeaders,
      { ...headers, origin: 'http://untrusted.test' },
    ]) {
      const denied = await app.inject({
        method: 'POST',
        url: '/trpc/readFile',
        headers: deniedHeaders,
        payload: { path: file },
      });
      expect(denied.statusCode).toBe(403);
    }

    const staleProtocol = await app.inject({
      method: 'POST',
      url: '/trpc/readFile',
      headers: { ...headers, 'x-dashboard-protocol-version': '2' },
      payload: { path: file },
    });
    expect(staleProtocol.statusCode).toBe(400);
  });
});
