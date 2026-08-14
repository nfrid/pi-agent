import {
  DashboardSnapshotResponseSchema,
  parseBootstrapRequest,
  parseProtocolInfo,
  tryParseSchema,
} from '@pi-dashboard/protocol';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';

const apps: ReturnType<typeof Fastify>[] = [];
const TOKEN = 'trpc-test-token';
const ORIGIN = 'http://dashboard.test';
const RAW_BOOTSTRAP_URL =
  '/trpc/bootstrap?input=%7B%22protocolVersion%22%3A1%7D';

function snapshot() {
  return {
    serverId: 'generation-1',
    revision: 4,
    cursor: 8,
    runtimes: [],
    workspaces: [],
    sessions: [],
    unread: [],
  } as const;
}

function context(): DashboardRouteContext {
  return {
    token: TOKEN,
    serverId: () => 'generation-1',
    origins: () => [ORIGIN],
    snapshot,
    workspaces: () => [],
    refreshWorkspaces: async () => [],
    composerCommands: async () => ({ commands: [] }),
    usage: async () => ({ usage: null }),
    readSession: async () => ({ entries: [], metadata: { id: 's' } }),
    readActiveDelegateTranscripts: async () => ({
      version: 1,
      serverId: 'generation-1',
      cursor: 8,
      sessionId: 's',
      runs: [],
    }),
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
    interaction: async () => ({}),
    markNotificationRead: () => undefined,
    markAllNotificationsRead: () => undefined,
    pushSubscribe: () => undefined,
    vapidPublicKey: () => null,
    handleSse: (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end();
    },
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function authHeaders(extra: Record<string, string> = {}) {
  return {
    origin: ORIGIN,
    'x-dashboard-token': TOKEN,
    ...extra,
  };
}

function input(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

describe('dashboard tRPC boundary', () => {
  it('serves authenticated protocolInfo and the production raw GET bootstrap shape', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();

    const infoResponse = await app.inject({
      method: 'GET',
      url: '/trpc/protocolInfo',
      headers: authHeaders(),
    });
    expect(infoResponse.statusCode).toBe(200);
    const info = parseProtocolInfo(infoResponse.json().result.data);
    expect(info.serverId).toBe(snapshot().serverId);
    expect(info.capabilities).toEqual({ bootstrap: true });
    expect(infoResponse.headers['cache-control']).toBe('no-store');
    expect(infoResponse.headers['access-control-allow-origin']).toBe(ORIGIN);

    const bootstrapResponse = await app.inject({
      method: 'GET',
      url: RAW_BOOTSTRAP_URL,
      headers: authHeaders(),
    });
    expect(bootstrapResponse.statusCode).toBe(200);
    const bootstrap = bootstrapResponse.json().result.data;
    expect(tryParseSchema(DashboardSnapshotResponseSchema, bootstrap)).toEqual(
      bootstrap,
    );
    expect(bootstrap.snapshot.serverId).toBe(info.serverId);
    expect(bootstrap.cursor).toBe(bootstrap.snapshot.cursor);
  });

  it('rejects malformed requests and reports a stable protocol mismatch code', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();

    const malformed = await app.inject({
      method: 'GET',
      url: `/trpc/bootstrap?input=${input({ protocolVersion: '1' })}`,
      headers: authHeaders(),
    });
    expect(malformed.statusCode).toBe(400);

    const mismatch = await app.inject({
      method: 'GET',
      url: `/trpc/bootstrap?input=${input({ protocolVersion: 2 })}`,
      headers: authHeaders(),
    });
    expect(mismatch.statusCode).toBe(400);
    const error = mismatch.json().error;
    expect(error.data.code).toBe('BAD_REQUEST');
    expect(error.data.domainCode).toBe('protocol-mismatch');
    expect(JSON.stringify(error)).not.toContain('sqlite');
  });

  it('rejects malformed output and formats a representative domain failure', async () => {
    const malformedApp = Fastify();
    apps.push(malformedApp);
    const malformedContext = context();
    malformedContext.snapshot = () => ({ ...snapshot(), extra: true }) as never;
    await malformedApp.register(dashboardRoutes, { context: malformedContext });
    await malformedApp.ready();
    const malformed = await malformedApp.inject({
      method: 'GET',
      url: `/trpc/bootstrap?input=${input({ protocolVersion: 1 })}`,
      headers: authHeaders(),
    });
    expect(malformed.statusCode).toBe(500);
    expect(malformed.json().error.data.code).toBe('INTERNAL_SERVER_ERROR');

    const conflictApp = Fastify();
    apps.push(conflictApp);
    const conflictContext = context();
    conflictContext.snapshot = () => {
      throw Object.assign(new Error('UNIQUE constraint failed: secret'), {
        code: 'active-writer',
      });
    };
    await conflictApp.register(dashboardRoutes, { context: conflictContext });
    await conflictApp.ready();
    const conflict = await conflictApp.inject({
      method: 'GET',
      url: `/trpc/bootstrap?input=${input({ protocolVersion: 1 })}`,
      headers: authHeaders(),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.data.domainCode).toBe('active-writer');
    expect(JSON.stringify(conflict.json())).not.toContain('UNIQUE');
  });

  it('retains auth, bearer, origin, CORS, no-store, and events behavior', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();

    const missing = await app.inject({
      method: 'GET',
      url: '/trpc/protocolInfo',
    });
    expect(missing.statusCode).toBe(401);
    const bearer = await app.inject({
      method: 'GET',
      url: '/trpc/protocolInfo',
      headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.statusCode).toBe(200);
    const forbiddenOrigin = await app.inject({
      method: 'GET',
      url: '/trpc/protocolInfo',
      headers: { 'x-dashboard-token': TOKEN, origin: 'http://evil.test' },
    });
    expect(forbiddenOrigin.statusCode).toBe(403);
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/trpc/protocolInfo',
      headers: {
        origin: ORIGIN,
        'access-control-request-private-network': 'true',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(preflight.headers['access-control-allow-private-network']).toBe(
      'true',
    );

    const events = await app.inject({
      method: 'GET',
      url: '/api/events',
      headers: authHeaders(),
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers['content-type']).toContain('text/event-stream');
  });

  it('parses the public request adapter with strict fields', () => {
    expect(parseBootstrapRequest({ protocolVersion: 1 })).toEqual({
      protocolVersion: 1,
    });
  });
});
