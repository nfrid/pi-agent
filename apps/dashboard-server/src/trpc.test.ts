import {
  AuthoritativeSessionSnapshotSchema,
  ShellSnapshotResponseSchema,
  parseShellSnapshotRequest,
  parseProtocolInfo,
  tryParseSchema,
} from '@pi-dashboard/protocol';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';
import { toDashboardTrpcError } from './trpc.js';

const apps: ReturnType<typeof Fastify>[] = [];
const TOKEN = 'trpc-test-token';
const ORIGIN = 'http://dashboard.test';
const RAW_SHELL_URL =
  '/trpc/shellSnapshot?input=%7B%22protocolVersion%22%3A2%7D';

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
    sessionSnapshot: async (sessionId, before) => ({
      metadata: {
        id: sessionId,
        file: '/tmp/session.jsonl',
        cwd: '/tmp',
        updatedAt: 1,
        ...(before === undefined ? {} : { entryCount: 0 }),
      },
      entries: [],
      history: { version: 1, start: 0, end: 0, hasOlder: false },
      entriesComplete: true,
      serverId: 'generation-1',
      cursor: 8,
      active: {
        pendingInteractions: [],
        messages: [],
        tools: [],
        delegates: [],
        truncated: false,
      },
      completeThroughCursor: before === undefined,
    }),
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
  it('serves authenticated protocol-v2 info and the production shell shape', async () => {
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
    expect(info.capabilities).toEqual({
      shellSnapshot: true,
      sessionSnapshot: true,
    });
    expect(infoResponse.headers['cache-control']).toBe('no-store');
    expect(infoResponse.headers['access-control-allow-origin']).toBe(ORIGIN);

    const shellResponse = await app.inject({
      method: 'GET',
      url: RAW_SHELL_URL,
      headers: authHeaders(),
    });
    expect(shellResponse.statusCode).toBe(200);
    const shell = shellResponse.json().result.data;
    expect(tryParseSchema(ShellSnapshotResponseSchema, shell)).toEqual(shell);
    expect(shell.snapshot.serverId).toBe(info.serverId);
    expect(shell.cursor).toBe(shell.snapshot.cursor);
    const removedBootstrap = await app.inject({
      method: 'GET',
      url: '/trpc/bootstrap?input=%7B%22protocolVersion%22%3A1%7D',
      headers: authHeaders(),
    });
    expect(removedBootstrap.statusCode).toBe(404);
  });

  it('serves authoritative shell and session queries', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();

    const shell = await app.inject({
      method: 'GET',
      url: `/trpc/shellSnapshot?input=${input({ protocolVersion: 2 })}`,
      headers: authHeaders(),
    });
    expect(shell.statusCode).toBe(200);
    expect(shell.json().result.data.snapshot.runtimes).toEqual([]);

    const session = await app.inject({
      method: 'GET',
      url: `/trpc/sessionSnapshot?input=${input({ sessionId: 's' })}`,
      headers: authHeaders(),
    });
    expect(session.statusCode).toBe(200);
    expect(
      tryParseSchema(
        AuthoritativeSessionSnapshotSchema,
        session.json().result.data,
      ),
    ).toEqual(session.json().result.data);
    expect(session.json().result.data.completeThroughCursor).toBe(true);
  });

  it('rejects malformed requests and reports a stable protocol mismatch code', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(dashboardRoutes, { context: context() });
    await app.ready();

    const malformed = await app.inject({
      method: 'GET',
      url: `/trpc/shellSnapshot?input=${input({ protocolVersion: '1' })}`,
      headers: authHeaders(),
    });
    expect(malformed.statusCode).toBe(400);

    const mismatch = await app.inject({
      method: 'GET',
      url: `/trpc/shellSnapshot?input=${input({ protocolVersion: 1 })}`,
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
      url: `/trpc/shellSnapshot?input=${input({ protocolVersion: 2 })}`,
      headers: authHeaders(),
    });
    expect(malformed.statusCode).toBe(500);
    expect(malformed.json().error.data.code).toBe('INTERNAL_SERVER_ERROR');

    const conflictApp = Fastify();
    apps.push(conflictApp);
    const conflictContext = context();
    conflictContext.snapshot = () => {
      throw Object.assign(new Error('The session is already active.'), {
        code: 'active-session',
        cause: new Error('UNIQUE constraint failed: secret'),
      });
    };
    await conflictApp.register(dashboardRoutes, { context: conflictContext });
    await conflictApp.ready();
    const conflict = await conflictApp.inject({
      method: 'GET',
      url: `/trpc/shellSnapshot?input=${input({ protocolVersion: 2 })}`,
      headers: authHeaders(),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.data.domainCode).toBe('active-session');
    expect(conflict.json().error.message).toBe(
      'The orchestration request conflicts with existing state.',
    );
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

  it('sanitizes database detail while retaining safe domain messages', () => {
    const wrapped = Object.assign(
      new Error('UNIQUE constraint failed: secret'),
      {
        code: 'active-session',
        cause: new Error('sqlite internal detail'),
      },
    );
    const conflict = toDashboardTrpcError(wrapped);
    expect(conflict.code).toBe('CONFLICT');
    expect(conflict.message).toBe(
      'The orchestration request conflicts with existing state.',
    );
    expect((conflict.cause as { code?: string }).code).toBe('active-session');

    const safe = toDashboardTrpcError(
      Object.assign(new Error('The session is already active.'), {
        code: 'active-session',
      }),
    );
    expect(safe.code).toBe('CONFLICT');
    expect(safe.message).toBe('The session is already active.');
  });

  it('parses the public request adapter with strict fields', () => {
    expect(parseShellSnapshotRequest({ protocolVersion: 2 })).toEqual({
      protocolVersion: 2,
    });
  });
});
