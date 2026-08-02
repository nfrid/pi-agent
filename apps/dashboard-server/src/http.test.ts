import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDashboardServer } from './http.js';

let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('dashboard HTTP boundary', () => {
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
