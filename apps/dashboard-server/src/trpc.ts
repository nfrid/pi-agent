import {
  type AuthoritativeSessionSnapshot,
  type BridgeCommand,
  type BrowserSnapshot,
  DASHBOARD_PROTOCOL_VERSION,
  type ProtocolInfo,
  ProtocolInfoSchema,
  parseAuthoritativeSessionSnapshot,
  parseRenameSessionMutationInput,
  parseRenameSessionMutationOutput,
  parseRestartRuntimeMutationInput,
  parseRestartRuntimeMutationOutput,
  parseRuntimeCommandInput,
  parseRuntimeCommandOutput,
  parseSchema,
  parseSessionFeedInput,
  parseSessionFeedMessage,
  parseShellFeedInput,
  parseShellFeedMessage,
  parseShellSnapshotResponse,
  parseStartRuntimeMutationInput,
  parseStartRuntimeMutationOutput,
  parseStopRuntimeMutationInput,
  parseStopRuntimeMutationOutput,
  type SessionFeedMessage,
  SessionSnapshotRequestSchema,
  type ShellFeedMessage,
  ShellSnapshotRequestSchema,
} from '@pi-dashboard/protocol';
import { initTRPC, TRPCError, tracked } from '@trpc/server';
import { fastifyRequestHandler } from '@trpc/server/adapters/fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionFeedRegistry, ShellFeed } from './live-feeds.js';

/**
 * The only context needed by the finite Phase 1 router.  The callbacks keep
 * generation ownership in DashboardServerImpl; this module never creates an
 * ID or caches a snapshot.
 */
export interface DashboardTrpcContext {
  readonly serverId: () => string;
  readonly snapshot: () => BrowserSnapshot;
  /** Authoritative shell query builder. */
  readonly shellSnapshot: () => unknown;
  readonly sessionSnapshot?: (
    sessionId: string,
    before?: string,
  ) => Promise<AuthoritativeSessionSnapshot>;
  readonly runtimeCommand?: (
    runtimeId: string,
    command: BridgeCommand,
  ) => Promise<unknown>;
  readonly startRuntime?: (input: unknown) => Promise<unknown>;
  readonly restartRuntime?: (input: unknown) => Promise<unknown>;
  readonly stopRuntime?: (input: unknown) => Promise<unknown>;
  readonly renameSession?: (input: unknown) => Promise<unknown>;
  readonly shellFeed?: ShellFeed;
  readonly sessionFeeds?: SessionFeedRegistry;
  readonly shellSnapshotAt?: (sequence: number) => unknown;
  readonly sessionSnapshotAt?: (
    sessionId: string,
    sequence: number,
  ) => Promise<AuthoritativeSessionSnapshot>;
  /** Injected by the HTTP adapter from the Last-Event-ID header. */
  readonly lastEventId?: string;
}

export const DASHBOARD_DOMAIN_CODES = [
  'active-session',
  'merge-conflict',
  'restart-precondition',
  'idempotency-conflict',
  'active-writer',
  'sqlite-constraint',
  'orchestration-conflict',
  'session-assigned',
  'unknown-workspace',
  'protocol-mismatch',
] as const;
export type DashboardDomainCode = (typeof DASHBOARD_DOMAIN_CODES)[number];

const domainCodes = new Set<string>(DASHBOARD_DOMAIN_CODES);
const databaseDetailPattern =
  /sqlite|unique constraint|constraint failed|database is locked|no such table|malformed database/i;

function domainCode(error: unknown): DashboardDomainCode | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && domainCodes.has(code))
      return code as DashboardDomainCode;
    const message = current instanceof Error ? current.message : '';
    if (/sqlite|unique constraint/i.test(message)) return 'sqlite-constraint';
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function transportCode(
  code: DashboardDomainCode,
): 'BAD_REQUEST' | 'CONFLICT' | 'NOT_FOUND' {
  if (code === 'unknown-workspace') return 'NOT_FOUND';
  if (
    code === 'active-session' ||
    code === 'merge-conflict' ||
    code === 'restart-precondition' ||
    code === 'idempotency-conflict' ||
    code === 'active-writer' ||
    code === 'sqlite-constraint' ||
    code === 'orchestration-conflict' ||
    code === 'session-assigned'
  )
    return 'CONFLICT';
  return 'BAD_REQUEST';
}

function containsDatabaseDetail(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const message = current instanceof Error ? current.message : '';
    if (databaseDetailPattern.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function publicMessage(
  error: unknown,
  code: DashboardDomainCode | undefined,
): string {
  if (
    code === 'active-writer' ||
    code === 'sqlite-constraint' ||
    containsDatabaseDetail(error)
  )
    return 'The orchestration request conflicts with existing state.';
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'Dashboard request failed.';
}

/** Convert domain failures without exposing database or implementation detail. */
export function toDashboardTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  const code = domainCode(error);
  return new TRPCError({
    code: code ? transportCode(code) : 'INTERNAL_SERVER_ERROR',
    message: publicMessage(error, code),
    cause: error,
  });
}

function protocolMismatch(): Error {
  return Object.assign(new Error('Protocol version mismatch.'), {
    code: 'protocol-mismatch',
  });
}

const t = initTRPC.context<DashboardTrpcContext>().create({
  sse: {
    ping: { enabled: true, intervalMs: 15_000 },
    client: { reconnectAfterInactivityMs: 5 * 60_000 },
  },
  errorFormatter({ shape, error }) {
    const code = domainCode(error);
    return {
      ...shape,
      data: {
        ...shape.data,
        ...(code ? { domainCode: code } : {}),
      },
    };
  },
});

/** The module-level router keeps the exported client contract concrete. */
const dashboardRouter = t.router({
  protocolInfo: t.procedure
    .output((value: unknown) =>
      parseSchema(ProtocolInfoSchema, value, 'protocol info output'),
    )
    .query(({ ctx }): ProtocolInfo => {
      try {
        return {
          protocolVersion: DASHBOARD_PROTOCOL_VERSION,
          serverId: ctx.serverId(),
          capabilities: { shellSnapshot: true, sessionSnapshot: true },
        };
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  shellSnapshot: t.procedure
    .input((value: unknown) =>
      parseSchema(ShellSnapshotRequestSchema, value, 'shell snapshot request'),
    )
    .output((value: unknown) => parseShellSnapshotResponse(value))
    .query(({ ctx, input }) => {
      if (input.protocolVersion !== DASHBOARD_PROTOCOL_VERSION)
        throw toDashboardTrpcError(protocolMismatch());
      try {
        return parseShellSnapshotResponse(ctx.shellSnapshot());
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  sessionSnapshot: t.procedure
    .input((value: unknown) =>
      parseSchema(
        SessionSnapshotRequestSchema,
        value,
        'session snapshot request',
      ),
    )
    .output((value: unknown) => parseAuthoritativeSessionSnapshot(value))
    .query(async ({ ctx, input }) => {
      if (!ctx.sessionSnapshot)
        throw toDashboardTrpcError(
          new Error('Authoritative session snapshots are unavailable.'),
        );
      try {
        return parseAuthoritativeSessionSnapshot(
          await ctx.sessionSnapshot(input.sessionId, input.before),
        );
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  runtimeCommand: t.procedure
    .input((value: unknown) => parseRuntimeCommandInput(value))
    .output((value: unknown) => parseRuntimeCommandOutput(value))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.runtimeCommand)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Runtime commands are unavailable.',
        });
      try {
        return parseRuntimeCommandOutput(
          await ctx.runtimeCommand(input.runtimeId, input.command),
        );
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  startRuntime: t.procedure
    .input((value: unknown) => parseStartRuntimeMutationInput(value))
    .output((value: unknown) => parseStartRuntimeMutationOutput(value))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.startRuntime)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Runtime start is unavailable.',
        });
      try {
        return parseStartRuntimeMutationOutput(await ctx.startRuntime(input));
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  restartRuntime: t.procedure
    .input((value: unknown) => parseRestartRuntimeMutationInput(value))
    .output((value: unknown) => parseRestartRuntimeMutationOutput(value))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.restartRuntime)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Runtime restart is unavailable.',
        });
      try {
        return parseRestartRuntimeMutationOutput(
          await ctx.restartRuntime(input),
        );
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  stopRuntime: t.procedure
    .input((value: unknown) => parseStopRuntimeMutationInput(value))
    .output((value: unknown) => parseStopRuntimeMutationOutput(value))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.stopRuntime)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Runtime stop is unavailable.',
        });
      try {
        return parseStopRuntimeMutationOutput(await ctx.stopRuntime(input));
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  renameSession: t.procedure
    .input((value: unknown) => parseRenameSessionMutationInput(value))
    .output((value: unknown) => parseRenameSessionMutationOutput(value))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.renameSession)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Session rename is unavailable.',
        });
      try {
        return parseRenameSessionMutationOutput(await ctx.renameSession(input));
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  shellSubscribe: t.procedure
    .input((value: unknown) => parseShellFeedInput(value))
    .subscription(async function* ({ ctx, input, signal }) {
      const shellFeed = ctx.shellFeed;
      const shellSnapshotAt = ctx.shellSnapshotAt;
      if (!shellFeed || !shellSnapshotAt)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Shell feed is unavailable.',
        });
      const after = ctx.lastEventId ?? input.lastEventId;
      for await (const item of shellFeed.subscribe({
        lastEventId: after,
        signal,
        buildSnapshot: async (sequence) =>
          parseShellSnapshotResponse(shellSnapshotAt(sequence)),
      })) {
        const message: ShellFeedMessage =
          item.kind === 'snapshot'
            ? {
                type: 'snapshot',
                sequence: item.sequence,
                snapshot: item.snapshot,
              }
            : item.kind === 'caught-up'
              ? { type: 'caught-up', sequence: item.sequence }
              : { ...item.event, sequence: item.sequence };
        yield tracked(item.id, parseShellFeedMessage(message));
      }
    }),
  sessionSubscribe: t.procedure
    .input((value: unknown) => parseSessionFeedInput(value))
    .subscription(async function* ({ ctx, input, signal }) {
      const sessionFeeds = ctx.sessionFeeds;
      const sessionSnapshotAt = ctx.sessionSnapshotAt;
      if (!sessionFeeds || !sessionSnapshotAt)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Session feed is unavailable.',
        });
      const feed = sessionFeeds.get(input.sessionId);
      const after = ctx.lastEventId ?? input.lastEventId;
      for await (const item of feed.subscribe({
        lastEventId: after,
        signal,
        buildSnapshot: (sequence) =>
          sessionSnapshotAt(input.sessionId, sequence),
      })) {
        const message: SessionFeedMessage =
          item.kind === 'snapshot'
            ? {
                type: 'snapshot',
                sequence: item.sequence,
                snapshot: item.snapshot,
              }
            : item.kind === 'caught-up'
              ? { type: 'caught-up', sequence: item.sequence }
              : { ...item.event, sequence: item.sequence };
        yield tracked(item.id, parseSessionFeedMessage(message));
      }
    }),
});

export type DashboardRouter = typeof dashboardRouter;

export function createDashboardRouter(
  _context: DashboardTrpcContext,
): DashboardRouter {
  return dashboardRouter;
}

/** Register on the existing encapsulated Fastify instance, after auth hooks. */
export function registerDashboardTrpc(
  app: FastifyInstance,
  context: DashboardTrpcContext,
): void {
  const router = createDashboardRouter(context);
  app.all<{ Params: { path: string } }>(
    '/trpc/:path',
    async (
      request: FastifyRequest<{ Params: { path: string } }>,
      reply: FastifyReply,
    ) => {
      await fastifyRequestHandler({
        router,
        req: request,
        res: reply,
        path: request.params.path,
        createContext: () => ({
          ...context,
          lastEventId:
            typeof request.headers['last-event-id'] === 'string'
              ? request.headers['last-event-id']
              : undefined,
        }),
        allowMethodOverride: true,
      });
    },
  );
}
