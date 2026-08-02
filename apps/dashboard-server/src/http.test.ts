import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serializeFrame } from '@pi-dashboard/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDashboardServer } from './http.js';

let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('dashboard HTTP boundary', () => {
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
