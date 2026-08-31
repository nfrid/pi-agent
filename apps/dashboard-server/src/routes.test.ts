import {
  type DashboardSettings,
  usageHistoryPeriod,
} from '@pi-dashboard/protocol';
import Fastify from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function context(): DashboardRouteContext {
  return {
    token: 'route-token',
    serverId: () => 'server',
    origins: () => ['http://dashboard.test'],
    snapshot: () => ({
      serverId: 'server',
      revision: 1,
      cursor: 1,
      runtimes: [],
      sessions: [],
      unread: [],
    }),
    sessionThreadLinks: () => [
      {
        sessionId: 'session-1',
        threadId: 'thread-1',
        pinnedAt: 20,
        activeRunId: 'run-1',
      },
    ],
    usage: async () => ({ usage: null }),
    usageHistory: (range, before) => {
      const generatedAt = before ?? 100 * 24 * 60 * 60_000;
      const period = usageHistoryPeriod(range, generatedAt);
      return {
        range,
        generatedAt,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        bucket: period.bucket,
        buckets: period.buckets,
        series: [],
        spend: [],
      };
    },
    readDelegateHistory: async () => ({
      version: 2,
      sessionId: 's',
      groups: [],
    }),
    readDelegateHistoryRun: async (id, runId, query) => ({
      version: 1,
      sessionId: id,
      lineageId: query.lineageId ?? 'lineage-1',
      runId,
      run: {
        runId,
        lineageId: query.lineageId ?? 'lineage-1',
        name: 'Worker',
        kind: 'background',
        state: 'success',
        createdAt: 1,
        allowWrites: false,
        details: { truncated: false },
      },
    }),
    renameSession: async () => ({ metadata: { id: 's' } }),
    startRuntime: async () => ({ runtimeId: 'runtime' }),
    commandRuntime: async () => ({ accepted: true }),
    stopRuntime: async () => undefined,
    markNotificationRead: () => undefined,
    markAllNotificationsRead: () => undefined,
    pushSubscribe: () => undefined,
    vapidPublicKey: () => null,
  };
}

describe('Fastify dashboard route plugin', () => {
  it('returns the exact persisted session/thread projection', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/api/session-threads',
      headers: {
        origin: 'http://dashboard.test',
        'x-dashboard-token': 'route-token',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        sessionId: 'session-1',
        threadId: 'thread-1',
        pinnedAt: 20,
        activeRunId: 'run-1',
      },
    ]);
  });

  it('atomically updates, resets, and imports authenticated model settings', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    let settings: DashboardSettings = { modelDisplayPreferences: {} };
    routeContext.settings = () => settings;
    routeContext.updateModelDisplayPreference = vi.fn((key, preference) => {
      settings = {
        modelDisplayPreferences: {
          ...settings.modelDisplayPreferences,
          [key]: preference,
        },
      };
      return settings;
    });
    routeContext.resetModelDisplayPreference = vi.fn((key) => {
      const next = { ...settings.modelDisplayPreferences };
      delete next[key];
      settings = { modelDisplayPreferences: next };
      return settings;
    });
    routeContext.importModelDisplayPreferences = vi.fn((preferences) => {
      settings = {
        modelDisplayPreferences: {
          ...preferences,
          ...settings.modelDisplayPreferences,
        },
      };
      return settings;
    });
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
    };
    const initial = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers,
    });
    expect(initial.statusCode).toBe(200);
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/settings/model-display-preferences/openai%2Fgpt-5',
      headers,
      payload: { alias: 'GPT', color: '#ff79c6' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      modelDisplayPreferences: {
        'openai/gpt-5': { alias: 'GPT', color: '#ff79c6' },
      },
    });
    const imported = await app.inject({
      method: 'POST',
      url: '/api/settings/model-display-preferences/import',
      headers,
      payload: {
        modelDisplayPreferences: {
          'openai/gpt-5': { alias: 'Stale local' },
          'anthropic/claude-3': { alias: 'Claude' },
        },
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toEqual({
      modelDisplayPreferences: {
        'openai/gpt-5': { alias: 'GPT', color: '#ff79c6' },
        'anthropic/claude-3': { alias: 'Claude' },
      },
    });
    const reset = await app.inject({
      method: 'DELETE',
      url: '/api/settings/model-display-preferences/openai%2Fgpt-5',
      headers,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({
      modelDisplayPreferences: {
        'anthropic/claude-3': { alias: 'Claude' },
      },
    });
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/settings/model-display-preferences/openai%2Fgpt-5',
      headers,
      payload: { color: 'red' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('rejects settings updates when persistence is unavailable', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/model-display-preferences/openai%2Fgpt-5',
      headers: {
        origin: 'http://dashboard.test',
        'x-dashboard-token': 'route-token',
      },
      payload: { alias: 'GPT' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'Orchestration is unavailable.',
    });
  });

  it('serves authenticated delegate history by session ID', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    routeContext.readDelegateHistory = vi.fn(async (id) => ({
      version: 2 as const,
      sessionId: id,
      groups: [],
    }));
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/offline-1/delegate-history',
      headers: {
        origin: 'http://dashboard.test',
        'x-dashboard-token': 'route-token',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: 2,
      sessionId: 'offline-1',
      groups: [],
    });
    expect(routeContext.readDelegateHistory).toHaveBeenCalledWith('offline-1');
  });

  it('serves a bounded authenticated WebP thumbnail separately from the original', async () => {
    const app = Fastify();
    apps.push(app);
    const original = await sharp({
      create: {
        width: 1000,
        height: 800,
        channels: 3,
        background: '#c44',
      },
    })
      .png()
      .toBuffer();
    const routeContext = context();
    routeContext.sessionImage = vi.fn(async () => ({
      data: original,
      mediaType: 'image/png',
    }));
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
    };

    const thumbnail = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/images/live-entry/0?variant=thumbnail&timestamp=12345',
      headers,
    });
    expect(thumbnail.statusCode).toBe(200);
    expect(routeContext.sessionImage).toHaveBeenCalledWith(
      'session-1',
      'live-entry',
      0,
      12345,
    );
    expect(thumbnail.headers['content-type']).toContain('image/webp');
    expect(thumbnail.headers['cache-control']).toBe('no-store');
    await expect(sharp(thumbnail.rawPayload).metadata()).resolves.toMatchObject(
      {
        format: 'webp',
        width: 300,
        height: 240,
      },
    );

    const full = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/images/entry-1/0',
      headers,
    });
    expect(full.headers['content-type']).toContain('image/png');
    expect(full.headers['cache-control']).toBe('no-store');
    expect(full.rawPayload).toEqual(original);
  });

  it('serves authenticated project icons without caching', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    routeContext.projectIcon = vi.fn(async () => ({
      data: Buffer.from('<svg>project</svg>'),
      mediaType: 'image/svg+xml',
      source: 'custom' as const,
    }));
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/projects/project-1/icon',
      headers: {
        origin: 'http://dashboard.test',
        'x-dashboard-token': 'route-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/svg+xml');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-project-icon-source']).toBe('custom');
    expect(response.body).toBe('<svg>project</svg>');
    expect(routeContext.projectIcon).toHaveBeenCalledWith('project-1');
  });

  it('uploads and resets a custom project icon', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    routeContext.setProjectIcon = vi.fn(async () => undefined);
    routeContext.projectIconFiles = vi.fn(async () => ({
      suggestions: [
        { value: './project.svg', label: 'project.svg', directory: false },
      ],
    }));
    routeContext.setProjectIconFromPath = vi.fn(async () => undefined);
    routeContext.resetProjectIcon = vi.fn(async () => undefined);
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const form = new FormData();
    form.set(
      'icon',
      new Blob(['custom-icon'], { type: 'image/png' }),
      'icon.png',
    );
    const request = new Request('http://dashboard.test', {
      method: 'PUT',
      body: form,
    });
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
    };

    const uploaded = await app.inject({
      method: 'PUT',
      url: '/api/projects/project-1/icon',
      headers: {
        ...headers,
        'content-type': request.headers.get('content-type') as string,
      },
      payload: Buffer.from(await request.arrayBuffer()),
    });
    const files = await app.inject({
      method: 'GET',
      url: '/api/projects/project-1/icon/files?query=.%2F',
      headers,
    });
    const selected = await app.inject({
      method: 'PUT',
      url: '/api/projects/project-1/icon/project-file',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: 'assets/project.svg' }),
    });
    const reset = await app.inject({
      method: 'DELETE',
      url: '/api/projects/project-1/icon',
      headers,
    });

    expect(uploaded.statusCode).toBe(204);
    expect(routeContext.setProjectIcon).toHaveBeenCalledWith(
      'project-1',
      Buffer.from('custom-icon'),
    );
    expect(files.statusCode).toBe(200);
    expect(files.json()).toEqual({
      suggestions: [
        { value: './project.svg', label: 'project.svg', directory: false },
      ],
    });
    expect(routeContext.projectIconFiles).toHaveBeenCalledWith(
      'project-1',
      './',
    );
    expect(selected.statusCode).toBe(204);
    expect(routeContext.setProjectIconFromPath).toHaveBeenCalledWith(
      'project-1',
      'assets/project.svg',
    );
    expect(reset.statusCode).toBe(204);
    expect(routeContext.resetProjectIcon).toHaveBeenCalledWith('project-1');
  });

  it('serves one selected delegate run detail with branch query pins', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    routeContext.readDelegateHistoryRun = vi.fn(async (id, runId, query) => ({
      version: 1 as const,
      sessionId: id,
      leafId: query.leafId,
      lineageId: query.lineageId ?? 'lineage-1',
      runId,
      run: {
        runId,
        lineageId: query.lineageId ?? 'lineage-1',
        name: 'Worker',
        kind: 'background' as const,
        state: 'success' as const,
        createdAt: 1,
        allowWrites: false,
        details: { response: 'selected only', truncated: false },
      },
    }));
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/offline-1/delegate-history/runs/run-1?lineageId=lineage-1&leafId=leaf-1',
      headers: {
        origin: 'http://dashboard.test',
        'x-dashboard-token': 'route-token',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().runId).toBe('run-1');
    expect(routeContext.readDelegateHistoryRun).toHaveBeenCalledWith(
      'offline-1',
      'run-1',
      { lineageId: 'lineage-1', leafId: 'leaf-1' },
    );
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
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/usage',
        headers: {
          origin: 'http://dashboard.test',
          'x-dashboard-token': 'route-token',
        },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    const history = await app.inject({
      method: 'GET',
      url: '/api/usage/history?range=7d&before=864000000',
      headers: {
        origin: 'http://dashboard.test',
        'x-dashboard-token': 'route-token',
      },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      range: '7d',
      generatedAt: 864000000,
      periodEnd: 864000000,
      bucket: 'day',
      series: [],
      spend: [],
    });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/usage/history?range=forever',
        headers: {
          origin: 'http://dashboard.test',
          'x-dashboard-token': 'route-token',
        },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it('keeps CORS preflight and TypeBox body schemas on the route boundary', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/snapshot',
      headers: {
        origin: 'http://dashboard.test',
        'access-control-request-private-network': 'true',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(
      'http://dashboard.test',
    );
    expect(preflight.headers['access-control-allow-private-network']).toBe(
      'true',
    );
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
    routeContext.renameProject = vi.fn(async (projectId, command) => ({
      id: projectId,
      title: (command as { title: string }).title,
    }));
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
          payload: { commandId: 'adopt-1', rootPath: '/tmp/repo' },
        })
      ).statusCode,
    ).toBe(201);
    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project-1',
      headers,
      payload: { commandId: 'rename-1', title: 'Renamed project' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(routeContext.renameProject).toHaveBeenCalledWith('project-1', {
      commandId: 'rename-1',
      title: 'Renamed project',
    });
    const invalidRename = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project-1',
      headers,
      payload: { commandId: 'rename-2', title: '', extra: true },
    });
    expect(invalidRename.statusCode).toBe(400);
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

    routeContext.restoreThread = vi.fn(async () => ({
      id: 'thread-1',
      projectId: 'project-1',
      title: 'Thread',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
    }));
    routeContext.regenerateThreadTitle = vi.fn(async () => ({
      id: 'thread-1',
      projectId: 'project-1',
      title: 'Regenerated thread',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
    }));
    routeContext.pinThread = vi.fn(async () => ({
      id: 'thread-1',
      projectId: 'project-1',
      title: 'Thread',
      status: 'completed',
      pinnedAt: 2,
      createdAt: 1,
      updatedAt: 2,
    }));
    routeContext.unpinThread = vi.fn(async () => ({
      id: 'thread-1',
      projectId: 'project-1',
      title: 'Thread',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
    }));
    routeContext.settleThread = vi.fn(async () => ({
      id: 'thread-1',
      projectId: 'project-1',
      title: 'Thread',
      status: 'completed',
      settledAt: 3,
      createdAt: 1,
      updatedAt: 3,
    }));
    routeContext.unsettleThread = vi.fn(async () => ({
      id: 'thread-1',
      projectId: 'project-1',
      title: 'Thread',
      status: 'completed',
      createdAt: 1,
      updatedAt: 4,
    }));
    const restore = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/restore',
      headers,
      payload: { commandId: 'restore-1' },
    });
    expect(restore.statusCode).toBe(200);
    expect(routeContext.restoreThread).toHaveBeenCalledWith(
      'thread-1',
      'restore-1',
    );
    const invalidRestore = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/restore',
      headers,
      payload: { commandId: 'restore-extra', extra: true },
    });
    expect(invalidRestore.statusCode).toBe(400);
    const regenerateTitle = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/regenerate-title',
      headers,
      payload: { commandId: 'regenerate-title-1' },
    });
    expect(regenerateTitle.statusCode).toBe(200);
    expect(routeContext.regenerateThreadTitle).toHaveBeenCalledWith(
      'thread-1',
      'regenerate-title-1',
    );
    const invalidRegenerateTitle = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/regenerate-title',
      headers,
      payload: { commandId: 'regenerate-title-extra', extra: true },
    });
    expect(invalidRegenerateTitle.statusCode).toBe(400);
    const pin = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/pin',
      headers,
      payload: { commandId: 'pin-1' },
    });
    expect(pin.statusCode).toBe(200);
    expect(routeContext.pinThread).toHaveBeenCalledWith('thread-1', 'pin-1');
    const invalidPin = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/pin',
      headers,
      payload: { commandId: 'pin-extra', extra: true },
    });
    expect(invalidPin.statusCode).toBe(400);
    const unpin = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/unpin',
      headers,
      payload: { commandId: 'unpin-1' },
    });
    expect(unpin.statusCode).toBe(200);
    expect(routeContext.unpinThread).toHaveBeenCalledWith(
      'thread-1',
      'unpin-1',
    );
    const invalidUnpin = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/unpin',
      headers,
      payload: { commandId: 'unpin-extra', extra: true },
    });
    expect(invalidUnpin.statusCode).toBe(400);
    const settle = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/settle',
      headers,
      payload: { commandId: 'settle-1' },
    });
    expect(settle.statusCode).toBe(200);
    expect(routeContext.settleThread).toHaveBeenCalledWith(
      'thread-1',
      'settle-1',
    );
    const invalidSettle = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/settle',
      headers,
      payload: { commandId: 'settle-extra', extra: true },
    });
    expect(invalidSettle.statusCode).toBe(400);
    const unsettle = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/unsettle',
      headers,
      payload: { commandId: 'unsettle-1' },
    });
    expect(unsettle.statusCode).toBe(200);
    expect(routeContext.unsettleThread).toHaveBeenCalledWith(
      'thread-1',
      'unsettle-1',
    );
    const invalidUnsettle = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/unsettle',
      headers,
      payload: { commandId: 'unsettle-extra', extra: true },
    });
    expect(invalidUnsettle.statusCode).toBe(400);

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

  it('accepts empty stop bodies but rejects malformed JSON bodies', async () => {
    const app = Fastify();
    apps.push(app);
    const routeContext = context();
    routeContext.stopRuntime = vi.fn(async () => undefined);
    await app.register(dashboardRoutes, { context: routeContext });
    await app.ready();
    const headers = {
      origin: 'http://dashboard.test',
      'x-dashboard-token': 'route-token',
    };

    for (const url of ['/api/runtimes/runtime/stop']) {
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
