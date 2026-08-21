import {
  type ActiveDelegateTranscriptBaseline,
  ArchiveThreadCommandSchema,
  type AuthoritativeSessionSnapshot,
  type BridgeCommand,
  type BrowserSnapshot,
  CancelCommandSchema,
  CheckoutActionCommandSchema,
  CheckoutReviewCommandSchema,
  type ComposerCommandCatalogue,
  type DelegateHistoryResponse,
  type DelegateHistoryRunDetailResponse,
  type DelegateHistoryRunQuery,
  DelegateHistoryRunQuerySchema,
  PinThreadCommandSchema,
  SettleThreadCommandSchema,
  UnsettleThreadCommandSchema,
  ProjectAdoptCommandSchema,
  ProjectCreateCommandSchema,
  RestoreThreadCommandSchema,
  RetryCommandSchema,
  SessionAdoptCommandSchema,
  SessionThreadLinksSchema,
  ThreadCreateCommandSchema,
  UnpinThreadCommandSchema,
  type WorkspaceTarget,
} from '@pi-dashboard/protocol';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { Type } from 'typebox';
import type { SessionFeedRegistry, ShellFeed } from './live-feeds.js';
import { allowedOrigin, authorizeRequest } from './security.js';
import { registerDashboardTrpc } from './trpc.js';

const MAX_JSON_BODY = 512 * 1024;
const MAX_MULTIPART_BODY = 12 * 1024 * 1024 + 256 * 1024;
const objectBody = Type.Object({}, { additionalProperties: true });
const anyBody = Type.Any();
const ThreadListQuerySchema = Type.Object(
  {
    projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

function validCommandId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

type BodyLimitError = Error & { code: string; statusCode: number };

function bodyTooLarge(): BodyLimitError {
  return Object.assign(new Error('Request body is too large.'), {
    code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    statusCode: 413,
  });
}

function parseJsonBody(
  request: FastifyRequest,
  body: Buffer,
  done: (error: Error | null, value?: unknown) => void,
): void {
  if (body.byteLength === 0) {
    const path = request.raw.url?.split('?', 1)[0];
    if (
      /^\/api\/runtimes\/[^/]+\/stop$/.test(path ?? '') ||
      /^\/api\/checkouts\/[^/]+\/review$/.test(path ?? '')
    ) {
      done(null, {});
      return;
    }
  }
  if (body.byteLength > MAX_JSON_BODY) {
    done(bodyTooLarge());
    return;
  }
  try {
    done(null, JSON.parse(body.toString('utf8')) as unknown);
  } catch (error) {
    const parseError =
      error instanceof Error ? error : new Error(String(error));
    Object.assign(parseError, { statusCode: 400 });
    done(parseError);
  }
}

export interface DashboardRouteContext {
  readonly token: string;
  serverId(): string;
  origins(): readonly string[];
  snapshot(): BrowserSnapshot;
  shellSnapshot?(): unknown;
  sessionSnapshot?(
    id: string,
    before?: string,
  ): Promise<AuthoritativeSessionSnapshot>;
  shellFeed?: ShellFeed;
  sessionFeeds?: SessionFeedRegistry;
  shellSnapshotAt?(sequence: number): unknown;
  sessionSnapshotAt?(
    id: string,
    sequence: number,
  ): Promise<AuthoritativeSessionSnapshot>;
  workspaces(): WorkspaceTarget[];
  refreshWorkspaces(): Promise<WorkspaceTarget[]>;
  composerCommands(workspaceId: string): Promise<ComposerCommandCatalogue>;
  usage(): Promise<{ usage: unknown; error?: string }>;
  readActiveDelegateTranscripts(
    id: string,
  ): Promise<ActiveDelegateTranscriptBaseline>;
  readDelegateHistory(id: string): Promise<DelegateHistoryResponse>;
  readDelegateHistoryRun(
    id: string,
    runId: string,
    query: DelegateHistoryRunQuery,
  ): Promise<DelegateHistoryRunDetailResponse>;
  renameSession(id: string, name: string): Promise<unknown>;
  startRuntime(input: unknown): Promise<unknown>;
  restartRuntime?(runtimeId: string, commandId: string): Promise<unknown>;
  commandRuntime(
    runtimeId: string,
    input: unknown,
    images: readonly Buffer[],
  ): Promise<unknown>;
  /** Non-multipart browser commands use the typed tRPC receipt boundary. */
  runtimeCommand?(runtimeId: string, command: BridgeCommand): Promise<unknown>;
  startRuntimeMutation?(input: unknown): Promise<unknown>;
  restartRuntimeMutation?(input: unknown): Promise<unknown>;
  stopRuntimeMutation?(input: unknown): Promise<unknown>;
  renameSessionMutation?(input: unknown): Promise<unknown>;
  stopRuntime(runtimeId: string, force: boolean): Promise<void>;
  markNotificationRead(id: string): void;
  markAllNotificationsRead(): void;
  pushSubscribe(body: unknown): void;
  vapidPublicKey(): string | null;
  adoptProject?(command: unknown): Promise<unknown>;
  createThread?(projectId: string, command: unknown): Promise<unknown>;
  adoptSession?(
    projectId: string,
    sessionId: string,
    command: unknown,
  ): Promise<unknown>;
  retryRun?(threadId: string, command: unknown): Promise<unknown>;
  cancelRun?(runId: string, commandId: string): Promise<unknown>;
  reviewCheckout?(checkoutId: string): Promise<unknown>;
  mergeCheckout?(checkoutId: string, commandId: string): Promise<unknown>;
  retireCheckout?(checkoutId: string, commandId: string): Promise<unknown>;
  archiveThread?(threadId: string, commandId: string): Promise<unknown>;
  restoreThread?(threadId: string, commandId: string): Promise<unknown>;
  pinThread?(threadId: string, commandId: string): Promise<unknown>;
  unpinThread?(threadId: string, commandId: string): Promise<unknown>;
  settleThread?(threadId: string, commandId: string): Promise<unknown>;
  unsettleThread?(threadId: string, commandId: string): Promise<unknown>;
  listThreads?(projectId?: string): Promise<unknown> | unknown;
  sessionThreadLinks?(): unknown;
  readThread?(threadId: string): Promise<unknown> | unknown;
}

function errorCode(error: unknown): string | undefined {
  const explicit = (error as { code?: unknown }).code;
  if (typeof explicit === 'string') return explicit;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('unique constraint') || lower.includes('sqlite'))
    return 'sqlite-constraint';
  return undefined;
}

function errorStatus(error: unknown): number {
  const code = errorCode(error);
  return code === 'active-session' ||
    code === 'merge-conflict' ||
    code === 'restart-precondition' ||
    code === 'idempotency-conflict' ||
    code === 'active-writer' ||
    code === 'sqlite-constraint' ||
    code === 'orchestration-conflict' ||
    code === 'session-assigned' ||
    code === 'session-link-conflict'
    ? 409
    : code === 'unknown-workspace'
      ? 404
      : 400;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const code = errorCode(error);
  const databaseDetail =
    code === 'active-writer' || code === 'sqlite-constraint';
  return reply.code(errorStatus(error)).send({
    error: databaseDetail
      ? 'The orchestration request conflicts with existing state.'
      : error instanceof Error
        ? error.message
        : String(error),
    ...(code === undefined ? {} : { code }),
  });
}

function requireOperation<T extends (...args: never[]) => unknown>(
  operation: T | undefined,
): T {
  if (!operation) throw new Error('Orchestration is unavailable.');
  return operation;
}

async function multipartPayload(
  request: FastifyRequest,
): Promise<{ body: Record<string, unknown>; images: Buffer[] }> {
  const raw = request.body;
  if (!Buffer.isBuffer(raw)) throw new Error('Invalid multipart request.');
  const form = await new Response(new Uint8Array(raw), {
    headers: { 'content-type': request.headers['content-type'] ?? '' },
  }).formData();
  const commandPart = form.get('command');
  if (typeof commandPart !== 'string' || commandPart.length > 512 * 1024)
    throw new Error('Multipart command is required.');
  const parsed: unknown = JSON.parse(commandPart);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid multipart command.');
  const parts = form.getAll('images');
  const images: Buffer[] = [];
  for (const part of parts) {
    if (typeof part === 'string') throw new Error('Invalid image upload.');
    images.push(Buffer.from(await part.arrayBuffer()));
  }
  return { body: parsed as Record<string, unknown>, images };
}

async function commandPayload(
  request: FastifyRequest,
): Promise<{ body: unknown; images: Buffer[] }> {
  if (
    (request.headers['content-type'] ?? '').startsWith('multipart/form-data;')
  )
    return multipartPayload(request);
  return { body: request.body ?? {}, images: [] };
}

function installCorsAndAuth(
  app: FastifyInstance,
  context: DashboardRouteContext,
): void {
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && context.origins().includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header(
        'access-control-allow-headers',
        'authorization, content-type, last-event-id, x-dashboard-protocol-version, x-dashboard-token',
      );
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      if (request.headers['access-control-request-private-network'] === 'true')
        reply.header('access-control-allow-private-network', 'true');
      reply.header('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      if (!allowedOrigin(origin, context.origins()))
        return reply.code(403).send({ error: 'Origin is not allowed.' });
      return reply.code(204).send();
    }
    if (request.url.split('?', 1)[0] === '/api/health') return;
    const auth = authorizeRequest({
      method: request.method,
      origin,
      authorization: request.headers.authorization,
      tokenHeader: request.headers['x-dashboard-token'] as string | undefined,
      expectedToken: context.token,
      allowedOrigins: context.origins(),
    });
    if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
  });
}

export const dashboardRoutes: FastifyPluginAsync<{
  context: DashboardRouteContext;
}> = async (app, options) => {
  const { context } = options;
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    return reply.code(statusCode).send({
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string }).code,
    });
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: MAX_JSON_BODY },
    parseJsonBody,
  );
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: MAX_MULTIPART_BODY },
    (_request, body, done) => done(null, body),
  );
  installCorsAndAuth(app, context);
  registerDashboardTrpc(app, {
    serverId: context.serverId,
    snapshot: context.snapshot,
    shellSnapshot:
      context.shellSnapshot ??
      (() => {
        const snapshot = context.snapshot();
        return { snapshot, cursor: snapshot.cursor };
      }),
    sessionSnapshot: context.sessionSnapshot,
    shellFeed: context.shellFeed,
    sessionFeeds: context.sessionFeeds,
    shellSnapshotAt: context.shellSnapshotAt,
    sessionSnapshotAt: context.sessionSnapshotAt,
    runtimeCommand: context.runtimeCommand,
    startRuntime: context.startRuntimeMutation,
    restartRuntime: context.restartRuntimeMutation,
    stopRuntime: context.stopRuntimeMutation,
    renameSession: context.renameSessionMutation,
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'Not found.' }),
  );

  app.options('/*', async (_request, reply) => reply.code(204).send());
  app.get(
    '/api/health',
    { schema: { response: { 200: Type.Object({ ok: Type.Boolean() }) } } },
    async () => ({ ok: true }),
  );
  app.get('/api/workspaces', async () => ({
    workspaces: context.workspaces(),
  }));
  app.get(
    '/api/session-threads',
    { schema: { response: { 200: SessionThreadLinksSchema } } },
    async () => context.sessionThreadLinks?.() ?? [],
  );
  app.post('/api/workspaces/refresh', async (_request, reply) => {
    try {
      return { workspaces: await context.refreshWorkspaces() };
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/composer-commands',
    async (request, reply) => {
      try {
        return await context.composerCommands(request.params.workspaceId);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get('/api/usage', async (_request, reply) => {
    try {
      return await context.usage();
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/api/push/vapid-public-key', async () => ({
    publicKey: context.vapidPublicKey(),
  }));

  const projectBody = { schema: { body: ProjectCreateCommandSchema } };
  const adoptBody = { schema: { body: ProjectAdoptCommandSchema } };
  app.post('/api/projects', projectBody, async (request, reply) => {
    try {
      return reply
        .code(201)
        .send(await requireOperation(context.adoptProject)(request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/api/projects/adopt', adoptBody, async (request, reply) => {
    try {
      return reply
        .code(201)
        .send(await requireOperation(context.adoptProject)(request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/threads',
    { schema: { body: ThreadCreateCommandSchema } },
    async (request, reply) => {
      try {
        return reply
          .code(202)
          .send(
            await requireOperation(context.createThread)(
              request.params.projectId,
              request.body,
            ),
          );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { projectId: string; sessionId: string };
  }>(
    '/api/projects/:projectId/sessions/:sessionId/adopt',
    { schema: { body: SessionAdoptCommandSchema } },
    async (request, reply) => {
      try {
        return reply
          .code(201)
          .send(
            await requireOperation(context.adoptSession)(
              request.params.projectId,
              request.params.sessionId,
              request.body,
            ),
          );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{ Params: { threadId: string } }>(
    '/api/threads/:threadId/retry',
    { schema: { body: RetryCommandSchema } },
    async (request, reply) => {
      try {
        return reply
          .code(202)
          .send(
            await requireOperation(context.retryRun)(
              request.params.threadId,
              request.body,
            ),
          );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  for (const route of ['/cancel', '/interrupt'] as const) {
    app.post<{ Params: { runId: string } }>(
      `/api/runs/:runId${route}`,
      { schema: { body: CancelCommandSchema } },
      async (request, reply) => {
        try {
          return reply
            .code(202)
            .send(
              await requireOperation(context.cancelRun)(
                request.params.runId,
                (request.body as { commandId: string }).commandId,
              ),
            );
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }
  app.get<{ Params: { checkoutId: string } }>(
    '/api/checkouts/:checkoutId/review',
    async (request, reply) => {
      try {
        return await requireOperation(context.reviewCheckout)(
          request.params.checkoutId,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{ Params: { checkoutId: string } }>(
    '/api/checkouts/:checkoutId/review',
    { schema: { body: CheckoutReviewCommandSchema } },
    async (request, reply) => {
      try {
        return await requireOperation(context.reviewCheckout)(
          request.params.checkoutId,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{ Params: { checkoutId: string } }>(
    '/api/checkouts/:checkoutId/merge',
    { schema: { body: CheckoutActionCommandSchema } },
    async (request, reply) => {
      try {
        return await requireOperation(context.mergeCheckout)(
          request.params.checkoutId,
          (request.body as { commandId: string }).commandId,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{ Params: { checkoutId: string } }>(
    '/api/checkouts/:checkoutId/retire',
    { schema: { body: CheckoutActionCommandSchema } },
    async (request, reply) => {
      try {
        return await requireOperation(context.retireCheckout)(
          request.params.checkoutId,
          (request.body as { commandId: string }).commandId,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Querystring: { projectId?: string } }>(
    '/api/threads',
    { schema: { querystring: ThreadListQuerySchema } },
    async (request, reply) => {
      try {
        return await requireOperation(context.listThreads)(
          request.query.projectId,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Params: { threadId: string } }>(
    '/api/threads/:threadId',
    async (request, reply) => {
      try {
        return await requireOperation(context.readThread)(
          request.params.threadId,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{ Params: { threadId: string } }>(
    '/api/threads/:threadId/archive',
    { schema: { body: ArchiveThreadCommandSchema } },
    async (request, reply) => {
      try {
        return await requireOperation(context.archiveThread)(
          request.params.threadId,
          (request.body as { commandId: string }).commandId,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  for (const [suffix, operation, schema] of [
    ['restore', 'restoreThread', RestoreThreadCommandSchema],
    ['pin', 'pinThread', PinThreadCommandSchema],
    ['unpin', 'unpinThread', UnpinThreadCommandSchema],
    ['settle', 'settleThread', SettleThreadCommandSchema],
    ['unsettle', 'unsettleThread', UnsettleThreadCommandSchema],
  ] as const) {
    app.post<{ Params: { threadId: string } }>(
      `/api/threads/:threadId/${suffix}`,
      { schema: { body: schema } },
      async (request, reply) => {
        try {
          return await requireOperation(context[operation])(
            request.params.threadId,
            (request.body as { commandId: string }).commandId,
          );
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/delegate-transcripts/active',
    async (request, reply) => {
      try {
        return await context.readActiveDelegateTranscripts(request.params.id);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/delegate-history',
    async (request, reply) => {
      try {
        return await context.readDelegateHistory(request.params.id);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{
    Params: { id: string; runId: string };
    Querystring: DelegateHistoryRunQuery;
  }>(
    '/api/sessions/:id/delegate-history/runs/:runId',
    { schema: { querystring: DelegateHistoryRunQuerySchema } },
    async (request, reply) => {
      try {
        return await context.readDelegateHistoryRun(
          request.params.id,
          request.params.runId,
          request.query,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { id: string };
    Body: { name?: unknown };
  }>(
    '/api/sessions/:id/name',
    { schema: { body: objectBody } },
    async (request, reply) => {
      try {
        if (typeof request.body?.name !== 'string')
          throw new Error('Session name is required.');
        return {
          ok: true,
          ...((await context.renameSession(
            request.params.id,
            request.body.name,
          )) as {
            result?: unknown;
            metadata?: unknown;
          }),
        };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post(
    '/api/runtimes/start',
    { schema: { body: objectBody } },
    async (request, reply) => {
      try {
        return reply.code(201).send(await context.startRuntime(request.body));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{ Params: { runtimeId: string }; Body: { id?: unknown } }>(
    '/api/runtimes/:runtimeId/restart',
    { schema: { body: objectBody } },
    async (request, reply) => {
      try {
        if (!validCommandId(request.body?.id))
          throw new Error('Restart command ID is required.');
        if (!context.restartRuntime)
          throw new Error('Runtime restart is unavailable.');
        return {
          ok: true,
          result: await context.restartRuntime(
            request.params.runtimeId,
            request.body.id,
          ),
        };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{ Params: { runtimeId: string } }>(
    '/api/runtimes/:runtimeId/command',
    {
      bodyLimit: MAX_MULTIPART_BODY,
      schema: { body: anyBody },
    },
    async (request, reply) => {
      try {
        const payload = await commandPayload(request);
        return {
          ok: true,
          result: await context.commandRuntime(
            request.params.runtimeId,
            payload.body,
            payload.images,
          ),
        };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { runtimeId: string };
    Body: { force?: unknown };
  }>(
    '/api/runtimes/:runtimeId/stop',
    {
      preValidation: async (request) => {
        if (request.body === undefined) request.body = {};
      },
      schema: { body: objectBody },
    },
    async (request, reply) => {
      try {
        await context.stopRuntime(
          request.params.runtimeId,
          request.body?.force === true,
        );
        return { ok: true };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post('/api/notifications/read-all', async () => {
    context.markAllNotificationsRead();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>(
    '/api/notifications/:id/read',
    async (request) => {
      context.markNotificationRead(request.params.id);
      return { ok: true };
    },
  );
  app.post(
    '/api/push/subscribe',
    { schema: { body: objectBody } },
    async (request, reply) => {
      try {
        context.pushSubscribe(request.body);
        return reply.code(201).send({ ok: true });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
};
