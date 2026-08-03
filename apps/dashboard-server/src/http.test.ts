import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseFrame, serializeFrame } from '@pi-dashboard/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDashboardServer } from './http.js';

let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('dashboard HTTP boundary', () => {
  it('keeps the generated browser token stable across daemon restarts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-token-'));
    const options = {
      port: 0,
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    };
    server = await createDashboardServer(options);
    const token = server.token;
    expect(server.socketPath).toBe(path.join(root, 'state', 'bridge.sock'));
    await server.start();
    await server.stop();
    server = await createDashboardServer(options);
    expect(server.token).toBe(token);
  });

  it('authenticates WebSocket clients in the first message, not the URL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-ws-'));
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: origin },
    });
    const message = new Promise<string>((resolve, reject) => {
      socket.once('message', (value) => resolve(String(value)));
      socket.once('error', reject);
    });
    await new Promise<void>((resolve) => socket.once('open', () => resolve()));
    socket.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
    await expect(message).resolves.toContain('snapshot');
    socket.close();
  });

  it('publishes every browser update with the same monotonic revision as its snapshot', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-revision-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: origin },
    });
    const messages: string[] = [];
    socket.on('message', (value) => messages.push(String(value)));
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
    const waitForMessage = async (): Promise<Record<string, unknown>> => {
      while (messages.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 1));
      const message = messages.shift();
      if (!message) throw new Error('Expected a websocket message.');
      return JSON.parse(message) as Record<string, unknown>;
    };
    const initial = await waitForMessage();
    const initialSnapshot = initial.snapshot as { revision: number };
    expect(initial.type).toBe('snapshot');
    expect(initialSnapshot.revision).toBe(server.snapshot().revision);
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    const hello = {
      type: 'runtime.hello' as const,
      protocolVersion: 1,
      snapshot: {
        runtimeId: 'revision-runtime',
        ownership: 'external' as const,
        pid: 1,
        cwd: '/tmp',
        liveState: 'idle' as const,
        session: {
          id: 'revision-session',
          entries: [{ type: 'message', message: { role: 'user' } }],
        },
        pendingInteractions: [],
      },
    };
    bridge.write(serializeFrame({ kind: 'event', seq: 1, event: hello }));
    const registration = await waitForMessage();
    expect(registration.type).toBe('snapshot');
    const registrationSnapshot = registration.snapshot as { revision: number };
    expect(registrationSnapshot.revision).toBeGreaterThan(
      initialSnapshot.revision,
    );
    expect(server.snapshot().runtimes[0]?.session.entries).toEqual([]);
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: { type: 'runtime.stateChanged', state: 'working' },
      }),
    );
    const update = await waitForMessage();
    expect(update.type).toBe('event');
    expect(update.revision).toBe(
      (update.snapshot as { revision: number }).revision,
    );
    expect(update.revision).toBeGreaterThan(registrationSnapshot.revision);
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 3,
        event: {
          type: 'message.updated',
          sessionId: 'revision-session',
          message: { id: 'message-1', role: 'assistant' },
        },
      }),
    );
    const transcriptDelta = await waitForMessage();
    expect(transcriptDelta.type).toBe('event');
    expect(transcriptDelta.snapshot).toBeUndefined();
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 4,
        event: { type: 'runtime.goodbye' },
      }),
    );
    const goodbye = await waitForMessage();
    expect((goodbye.snapshot as { runtimes: unknown[] }).runtimes).toHaveLength(
      0,
    );
    await server.refreshWorkspaces();
    expect(server.snapshot().revision).toBeGreaterThan(
      update.revision as number,
    );
    bridge.destroy();
    socket.close();
  });

  it('serves active session entries before the file index catches up and contains unknown-session failures', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-active-session-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'external-runtime',
            ownership: 'external',
            pid: 123,
            cwd: '/tmp/project',
            liveState: 'idle',
            session: {
              id: 'live-session',
              name: 'Live session',
              entries: [{ type: 'message', id: 'one' }],
            },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const origin = `http://127.0.0.1:${server.port}`;
    const headers = { Origin: origin, 'x-dashboard-token': 'test-token' };
    const active = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/live-session`,
      { headers },
    );
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({
      metadata: { id: 'live-session', name: 'Live session' },
      entries: [{ type: 'message', id: 'one' }],
    });
    const missing = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/missing`,
      { headers },
    );
    expect(missing.status).toBe(400);
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/api/health`)).status,
    ).toBe(200);
    bridge.destroy();
  });

  it('forwards authenticated multipart images and removes temporary files after acknowledgement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-image-'));
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'image-runtime',
            ownership: 'external',
            pid: 456,
            cwd: '/tmp/project',
            liveState: 'idle',
            session: { id: 'image-session', entries: [] },
            model: {
              provider: 'test',
              model: 'vision',
              supportsImages: true,
            },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    let buffered = '';
    let temporaryPath: string | undefined;
    const commandSeen = new Promise<void>((resolve, reject) => {
      bridge.on('data', async (chunk) => {
        buffered += chunk.toString('utf8');
        const newline = buffered.indexOf('\n');
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const frame = parseFrame(line);
        if (frame.kind !== 'command') return;
        try {
          if (
            frame.command.type !== 'prompt' &&
            frame.command.type !== 'steer' &&
            frame.command.type !== 'followUp'
          )
            throw new Error('Expected a prompt command.');
          temporaryPath = frame.command.images?.[0]?.path;
          expect(frame.command).toMatchObject({
            type: 'prompt',
            text: 'describe this',
            images: [{ type: 'image', mediaType: 'image/png' }],
          });
          expect(temporaryPath).toBeTruthy();
          await expect(readFile(temporaryPath as string)).resolves.toBeTruthy();
          expect((await stat(temporaryPath as string)).mode & 0o777).toBe(
            0o600,
          );
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          bridge.write(
            serializeFrame({ kind: 'ack', id: frame.command.id, ok: true }),
          );
        }
      });
    });
    const form = new FormData();
    form.set(
      'command',
      JSON.stringify({ type: 'prompt', text: 'describe this' }),
    );
    form.append(
      'images',
      new Blob([
        new Uint8Array(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
        ),
      ]),
      'sample.png',
    );
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/runtimes/image-runtime/command`,
      {
        method: 'POST',
        headers: {
          Origin: `http://127.0.0.1:${server.port}`,
          'x-dashboard-token': 'test-token',
        },
        body: form,
      },
    );
    await commandSeen;
    expect(response.status).toBe(200);
    expect(temporaryPath).toBeTruthy();
    await expect(readFile(temporaryPath as string)).rejects.toThrow();
    bridge.destroy();
  });

  it('rejects spoofed image content and cleans partially written uploads', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-bad-image-'),
    );
    const stateDir = path.join(root, 'state');
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir,
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const form = new FormData();
    form.set('command', JSON.stringify({ type: 'prompt', text: 'inspect' }));
    form.append(
      'images',
      new Blob([
        new Uint8Array(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
        ),
      ]),
      'valid.png',
    );
    form.append(
      'images',
      new Blob([
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x62, 0x61, 0x64,
        ]),
      ]),
      'spoofed.png',
    );
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/runtimes/missing/command`,
      {
        method: 'POST',
        headers: {
          Origin: `http://127.0.0.1:${server.port}`,
          'x-dashboard-token': 'test-token',
        },
        body: form,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('PNG, JPEG, and WebP'),
    });
    expect(await readdir(path.join(stateDir, 'uploads'))).toEqual([]);
  });

  it('renames a dormant indexed session through the authenticated API', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-rename-http-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'dormant.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'dormant-id', cwd: '/tmp' })}
${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'dormant request' } })}
`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/dormant-id/name`,
      {
        method: 'POST',
        headers: {
          Origin: origin,
          'x-dashboard-token': 'test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Renamed dormant' }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      metadata: { id: 'dormant-id', name: 'Renamed dormant' },
    });
    expect(
      await readFile(path.join(sessionDir, 'dormant.jsonl'), 'utf8'),
    ).toContain('"type":"session_info"');
    expect(server.snapshot().sessions[0]).toMatchObject({
      id: 'dormant-id',
      name: 'Renamed dormant',
    });
  });

  it('coalesces and caches usage broker reads', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-usage-cache-'),
    );
    let calls = 0;
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
      usage: {
        get: async () => {
          calls += 1;
          return { calls };
        },
      },
    });
    await server.start();
    const url = `http://127.0.0.1:${server.port}/api/usage`;
    const headers = { 'x-dashboard-token': 'test-token' };
    const [first, second] = await Promise.all([
      fetch(url, { headers }),
      fetch(url, { headers }),
    ]);
    expect(await first.json()).toEqual({ usage: { calls: 1 } });
    expect(await second.json()).toEqual({ usage: { calls: 1 } });
    expect((await (await fetch(url, { headers })).json()) as unknown).toEqual({
      usage: { calls: 1 },
    });
    expect(calls).toBe(1);
  });

  it('contains invalid or oversized provider data without poisoning live snapshots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-usage-'));
    let usageValue: unknown = { invalid: 1n };
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
      usage: { get: async () => usageValue },
    });
    await server.start();
    const headers = { 'x-dashboard-token': 'test-token' };
    const usage = await fetch(`http://127.0.0.1:${server.port}/api/usage`, {
      headers,
    });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ error: expect.any(String) });
    usageValue = { oversized: 'x'.repeat(300_000) };
    const oversized = await fetch(`http://127.0.0.1:${server.port}/api/usage`, {
      headers,
    });
    expect(oversized.status).toBe(200);
    expect(await oversized.json()).toMatchObject({
      error: 'Usage payload exceeds the dashboard size limit.',
    });
    const snapshot = await fetch(
      `http://127.0.0.1:${server.port}/api/snapshot`,
      { headers },
    );
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ runtimes: [] });
  });

  it('requires auth/origin, supports CORS preflight, and returns an authoritative snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-http-'));
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const url = `http://127.0.0.1:${server.port}/api/snapshot`;
    expect((await fetch(url, { headers: { Origin: origin } })).status).toBe(
      401,
    );
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    const sameOriginResponse = await fetch(url, {
      headers: { 'x-dashboard-token': 'test-token' },
    });
    expect(sameOriginResponse.status).toBe(200);
    const response = await fetch(url, {
      headers: { Origin: origin, 'x-dashboard-token': 'test-token' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect((await response.json()) as { runtimes: unknown[] }).toMatchObject({
      runtimes: [],
      workspaces: [],
    });
  });
});
