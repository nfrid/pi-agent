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
    composerCommands: async () => ({ commands: [] }),
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

  it('serves authenticated workspace composer commands and rejects unknown ids', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    routeContext.composerCommands = vi.fn(async (workspaceId) => {
      if (workspaceId === 'missing')
        throw Object.assign(new Error('Unknown workspace.'), {
          code: 'unknown-workspace',
        });
      return { commands: [{ name: 'compact', source: 'builtin' as const }] };
    });
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
    };
    const commands = await app.inject({
      method: 'GET',
      url: '/api/workspaces/workspace-1/composer-commands',
      headers,
    });
    expect(commands.statusCode).toBe(200);
    expect(commands.json()).toEqual({
      commands: [{ name: 'compact', source: 'builtin' }],
    });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/workspaces/missing/composer-commands',
        headers,
      }),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/workspaces/workspace-1/composer-commands',
      }),
    ).resolves.toMatchObject({ statusCode: 401 });
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

  it('serves checkout review over GET and keeps empty review POST compatibility', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    routeContext.reviewCheckout = vi.fn(async () => ({ state: 'unmerged' }));
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
    };
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/checkouts/checkout-1/review',
        headers,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: 'POST',
        url: '/api/checkouts/checkout-1/review',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: '',
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(routeContext.reviewCheckout).toHaveBeenCalledTimes(2);
  });

  it('covers orchestration HTTP statuses, bounded schemas, auth, and coded conflicts', async () => {
    const app = Fastify({
      ajv: { customOptions: { removeAdditional: false } },
    });
    apps.push(app);
    const routeContext = context();
    const adopted = {
      project: { id: 'project-1' },
      checkout: { id: 'checkout-1' },
    };
    const created = { thread: { id: 'thread-1' }, run: { id: 'run-1' } };
    routeContext.adoptProject = vi.fn(async () => adopted);
    routeContext.adoptSession = vi.fn(async () => created);
    routeContext.createThread = vi.fn(async () => created);
    routeContext.retryRun = vi.fn(async () => created);
    routeContext.cancelRun = vi.fn(async () => ({
      id: 'run-1',
      status: 'cancelled',
    }));
    routeContext.reviewCheckout = vi.fn(async () => ({ state: 'unmerged' }));
    routeContext.mergeCheckout = vi.fn(async () => ({
      checkout: { status: 'retired' },
    }));
    routeContext.retireCheckout = vi.fn(async () => ({
      id: 'checkout-1',
      status: 'retired',
    }));
    routeContext.archiveThread = vi.fn(async () => ({
      id: 'thread-1',
      status: 'archived',
    }));
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
    };

    expect(
      (await app.inject({ method: 'GET', url: '/api/snapshot' })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/snapshot',
          headers: {
            origin: 'http://evil.test',
            'x-dashboard-token': 'route-token',
          },
        })
      ).statusCode,
    ).toBe(403);

    const invalidProject = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: {
        commandId: 'project-1',
        rootPath: '/tmp/repo',
        maxParallelRuns: 0,
        extra: true,
      },
    });
    expect(invalidProject.statusCode).toBe(400);
    const extraProject = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: {
        commandId: 'project-extra',
        rootPath: '/tmp/repo',
        extra: true,
      },
    });
    expect(extraProject.statusCode).toBe(400);
    expect(routeContext.adoptProject).not.toHaveBeenCalled();
    const missingCommand = await app.inject({
      method: 'POST',
      url: '/api/projects/project-1/threads',
      headers,
      payload: { title: 'Missing command', prompt: 'x' },
    });
    expect(missingCommand.statusCode).toBe(400);
    expect(routeContext.createThread).not.toHaveBeenCalled();

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects',
          headers,
          payload: { commandId: 'project-1', rootPath: '/tmp/repo' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects/adopt',
          headers,
          payload: { commandId: 'adopt-1', workspaceId: 'workspace-1' },
        })
      ).statusCode,
    ).toBe(201);
    const adoption = await app.inject({
      method: 'POST',
      url: '/api/projects/project-1/sessions/session-1/adopt',
      headers,
      payload: { commandId: 'session-adopt-1', title: 'Legacy session' },
    });
    expect(adoption.statusCode).toBe(201);
    expect(routeContext.adoptSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      { commandId: 'session-adopt-1', title: 'Legacy session' },
    );
    const extraAdoption = await app.inject({
      method: 'POST',
      url: '/api/projects/project-1/sessions/session-1/adopt',
      headers,
      payload: { commandId: 'session-adopt-2', extra: true },
    });
    expect(extraAdoption.statusCode).toBe(400);
    const threadRequest = {
      commandId: 'thread-1',
      title: 'Thread',
      prompt: 'Prompt',
    };
    const firstThread = await app.inject({
      method: 'POST',
      url: '/api/projects/project-1/threads',
      headers,
      payload: threadRequest,
    });
    const replayThread = await app.inject({
      method: 'POST',
      url: '/api/projects/project-1/threads',
      headers,
      payload: { ...threadRequest, title: 'Replacement' },
    });
    expect(firstThread.statusCode).toBe(202);
    expect(replayThread.statusCode).toBe(202);
    expect(replayThread.json()).toEqual(firstThread.json());
    expect(routeContext.createThread).toHaveBeenCalledTimes(2);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/threads/thread-1/retry',
          headers,
          payload: { commandId: 'retry-1' },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/runs/run-1/cancel',
          headers,
          payload: { commandId: 'cancel-1' },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/checkouts/checkout-1/review',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/checkouts/checkout-1/merge',
          headers,
          payload: { commandId: 'merge-1' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/checkouts/checkout-1/retire',
          headers,
          payload: { commandId: 'retire-1' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/threads/thread-1/archive',
          headers,
          payload: { commandId: 'archive-1' },
        })
      ).statusCode,
    ).toBe(200);

    routeContext.retryRun = vi.fn(async () => {
      throw new Error('Run missing.');
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/threads/missing/retry',
          headers,
          payload: { commandId: 'retry-missing' },
        })
      ).statusCode,
    ).toBe(400);
    routeContext.mergeCheckout = vi.fn(async () => {
      throw Object.assign(new Error('UNIQUE constraint failed: secret'), {
        code: 'active-writer',
      });
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/checkouts/checkout-1/merge',
      headers,
      payload: { commandId: 'merge-conflict' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).not.toContain('UNIQUE');
    expect(conflict.json().code).toBe('active-writer');
    routeContext.mergeCheckout = vi.fn(async () => {
      throw Object.assign(new Error('branch conflict'), {
        code: 'merge-conflict',
      });
    });
    const mergeConflict = await app.inject({
      method: 'POST',
      url: '/api/checkouts/checkout-1/merge',
      headers,
      payload: { commandId: 'merge-conflict-2' },
    });
    expect(mergeConflict.statusCode).toBe(409);
    expect(mergeConflict.json().code).toBe('merge-conflict');
    routeContext.retireCheckout = vi.fn(async () => {
      throw Object.assign(new Error('owned by another command'), {
        code: 'idempotency-conflict',
      });
    });
    const ownershipConflict = await app.inject({
      method: 'POST',
      url: '/api/checkouts/checkout-1/retire',
      headers,
      payload: { commandId: 'retire-conflict' },
    });
    expect(ownershipConflict.statusCode).toBe(409);
    expect(ownershipConflict.json().code).toBe('idempotency-conflict');
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
