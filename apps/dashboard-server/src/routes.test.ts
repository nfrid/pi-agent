import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('delegates restart IDs and workspace refresh through typed route boundaries', async () => {
    const app = Fastify();
    apps.push(app);
    const restart = vi.fn(async () => ({ runtimeId: 'restarted' }));
    const refreshWorkspaces = vi.fn(async () => [
      {
        id: 'workspace-1',
        name: 'Project',
        path: '/tmp/project',
        canonicalPath: '/tmp/project',
        source: 'directory' as const,
        active: true,
      },
    ]);
    const routeContext = context();
    routeContext.restartRuntime = restart;
    routeContext.refreshWorkspaces = refreshWorkspaces;
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
    };
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/workspaces/refresh',
      headers,
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().workspaces[0]).toMatchObject({ id: 'workspace-1' });
    expect(refreshWorkspaces).toHaveBeenCalledOnce();

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/runtimes/runtime-1/restart',
      headers,
      payload: { id: 'bad\u0000id' },
    });
    expect(invalid.statusCode).toBe(400);
    const restarted = await app.inject({
      method: 'POST',
      url: '/api/runtimes/runtime-1/restart',
      headers,
      payload: { id: 'restart-1' },
    });
    expect(restarted.statusCode).toBe(200);
    expect(restart).toHaveBeenCalledWith('runtime-1', 'restart-1');
  });

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

  it('accepts empty stop/cancel bodies but rejects malformed JSON bodies', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    routeContext.stopRuntime = vi.fn(async () => undefined);
    routeContext.interaction = vi.fn(async () => ({ accepted: true }));
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
    };

    for (const url of [
      '/api/runtimes/runtime/stop',
      '/api/interactions/interaction/cancel',
    ]) {
      await expect(
        app.inject({ method: 'POST', url, headers }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(
        app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: '',
        }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(
        app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: '{ malformed',
        }),
      ).resolves.toMatchObject({ statusCode: 400 });
    }
    expect(routeContext.stopRuntime).toHaveBeenCalledTimes(2);
    expect(routeContext.interaction).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized JSON before a route handler while allowing larger multipart commands', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    let called = false;
    let startCalled = false;
    routeContext.startRuntime = async () => {
      startCalled = true;
      return { runtimeId: 'unexpected' };
    };
    routeContext.commandRuntime = async () => {
      called = true;
      return { accepted: true };
    };
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
      'content-type': 'application/json',
    };
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/runtimes/runtime/command',
      headers,
      payload: JSON.stringify({ text: 'x'.repeat(512 * 1024) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.headers['cache-control']).toBe('no-store');
    expect(called).toBe(false);

    const globalOversized = await app.inject({
      method: 'POST',
      url: '/api/runtimes/start',
      headers,
      payload: JSON.stringify({
        workspaceId: 'workspace',
        value: 'x'.repeat(512 * 1024),
      }),
    });
    expect(globalOversized.statusCode).toBe(413);
    expect(startCalled).toBe(false);

    const form = new FormData();
    form.set('command', '{}');
    form.set('padding', 'x'.repeat(600 * 1024));
    const formRequest = new Request('http://dashboard.test', {
      method: 'POST',
      body: form,
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/runtimes/runtime/command',
      headers: {
        ...headers,
        'content-type': formRequest.headers.get('content-type') as string,
      },
      payload: Buffer.from(await formRequest.arrayBuffer()),
    });
    expect(accepted.statusCode).toBe(200);
    expect(called).toBe(true);
  });

  it('marks API success, auth, and not-found responses no-store', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();
    await expect(
      app.inject({ method: 'GET', url: '/api/health' }),
    ).resolves.toMatchObject({
      statusCode: 200,
      headers: { 'cache-control': 'no-store' },
    });
    await expect(
      app.inject({ method: 'GET', url: '/api/snapshot' }),
    ).resolves.toMatchObject({
      statusCode: 401,
      headers: { 'cache-control': 'no-store' },
    });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/missing',
        headers: {
          origin: 'http://dashboard.test',
          'x-dashboard-token': 'route-token',
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 404,
      headers: { 'cache-control': 'no-store' },
    });
  });
});
