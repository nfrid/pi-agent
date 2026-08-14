import {
  type AuthoritativeSessionSnapshot,
  type BrowserSnapshot,
  PROTOCOL_VERSION,
  type ProtocolInfo,
  ProtocolInfoSchema,
  parseAuthoritativeSessionSnapshot,
  parseSchema,
  parseShellSnapshotResponse,
  SessionSnapshotRequestSchema,
  ShellSnapshotRequestSchema,
} from '@pi-dashboard/protocol';
import { initTRPC, TRPCError } from '@trpc/server';
import { fastifyRequestHandler } from '@trpc/server/adapters/fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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

/**
 * Export this type for a later vanilla client type-only import.  The client
 * must import `@pi-dashboard/server/trpc` with `import type`; the router
 * factory is intentionally not part of the browser runtime bundle.
 */
export function createDashboardRouter(context: DashboardTrpcContext) {
  return t.router({
    protocolInfo: t.procedure
      .output((value: unknown) =>
        parseSchema(ProtocolInfoSchema, value, 'protocol info output'),
      )
      .query((): ProtocolInfo => {
        try {
          return {
            protocolVersion: PROTOCOL_VERSION,
            serverId: context.serverId(),
            capabilities: { shellSnapshot: true, sessionSnapshot: true },
          };
        } catch (error) {
          throw toDashboardTrpcError(error);
        }
      }),
    shellSnapshot: t.procedure
      .input((value: unknown) =>
        parseSchema(
          ShellSnapshotRequestSchema,
          value,
          'shell snapshot request',
        ),
      )
      .output((value: unknown) => parseShellSnapshotResponse(value))
      .query(({ input }) => {
        if (input.protocolVersion !== PROTOCOL_VERSION)
          throw toDashboardTrpcError(protocolMismatch());
        try {
          const response = context.shellSnapshot();
          return parseShellSnapshotResponse(response);
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
      .query(async ({ input }) => {
        if (!context.sessionSnapshot)
          throw toDashboardTrpcError(
            new Error('Authoritative session snapshots are unavailable.'),
          );
        try {
          return parseAuthoritativeSessionSnapshot(
            await context.sessionSnapshot(input.sessionId, input.before),
          );
        } catch (error) {
          throw toDashboardTrpcError(error);
        }
      }),
  });
}

export type DashboardRouter = ReturnType<typeof createDashboardRouter>;

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
        createContext: () => context,
      });
    },
  );
}
