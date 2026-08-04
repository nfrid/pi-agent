import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function context(): DashboardRouteContext {
  return {
    token: 'route-token',
    origins: () => ['http://dashboard.test'],
    snapshot: () => ({
      serverId: 'server',
      revision: 1,
      cursor: 1,
      runtimes: [],
      sessions: [],
      workspaces: [],
      unread: [],
    }),
    workspaces: () => [],
    refreshWorkspaces: async () => [],
    usage: async () => ({ usage: null }),
    readSession: async () => ({ entries: [], metadata: { id: 's' } }),
    renameSession: async () => ({ metadata: { id: 's' } }),
    startRuntime: async () => ({ runtimeId: 'runtime' }),
    commandRuntime: async () => ({ accepted: true }),
    stopRuntime: async () => undefined,
    interaction: async () => ({ accepted: true }),
    markNotificationRead: () => undefined,
    markAllNotificationsRead: () => undefined,
    pushSubscribe: () => undefined,
    vapidPublicKey: () => null,
    handleSse: () => undefined,
  };
}

describe('Fastify dashboard route plugin', () => {
  it('supports inject without starting an HTTP listener', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    await expect(
      app.inject({ method: 'GET', url: '/api/snapshot' }),
    ).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/snapshot',
        headers: {
          origin: 'http://dashboard.test',
          'x-dashboard-token': 'route-token',
        },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it('keeps CORS preflight and TypeBox body schemas on the route boundary', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();

    await expect(
      app.inject({
        method: 'OPTIONS',
        url: '/api/snapshot',
        headers: { origin: 'http://dashboard.test' },
      }),
    ).resolves.toMatchObject({ statusCode: 204 });
    await expect(
      app.inject({
        method: 'POST',
        url: '/api/runtimes/start',
        headers: {
          origin: 'http://dashboard.test',
          'x-dashboard-token': 'route-token',
          'content-type': 'application/json',
        },
        payload: [],
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });
});
