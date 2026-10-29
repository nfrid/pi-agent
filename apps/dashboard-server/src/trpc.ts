import {
  type AuthoritativeSessionSnapshot,
  type BackgroundJobEventsResponse,
  type BackgroundJobsResponse,
  type BridgeCommand,
  type BrowserSnapshot,
  type ComposerCommandCatalogue,
  ComposerCommandCatalogueSchema,
  ComposerFileSuggestionRequestSchema,
  type ComposerFileSuggestions,
  ComposerFileSuggestionsSchema,
  ComposerResourceRequestSchema,
  DASHBOARD_PROTOCOL_VERSION,
  type FileReadRequest,
  FileReadRequestSchema,
  type FileReadResult,
  FileReadResultSchema,
  type ProtocolInfo,
  ProtocolInfoSchema,
  parseAuthoritativeSessionSnapshot,
  parseBackgroundJobEventsInput,
  parseBackgroundJobEventsResponse,
  parseBackgroundJobEventsSubscribeInput,
  parseBackgroundJobsInput,
  parseBackgroundJobsResponse,
  parseBackgroundJobsSubscribeInput,
  parseLiveDiagnosticsRequest,
  parseLiveDiagnosticsResponse,
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
import {
  classifyDashboardError,
  type DashboardDomainCode,
} from './application/error-classification.js';
import { FileReadError } from './file-read.js';
import { FeedOverflowError, FeedPayloadTooLargeError } from './live-feed.js';
import type { SessionFeedRegistry, ShellFeed } from './live-feeds.js';
import {
  type NativeNotifications,
  nativeClickPath,
  nativeExternalUrl,
} from './native-notifications.js';
import {
  type DashboardTelemetry,
  parseBrowserTelemetryInput,
} from './telemetry.js';

export type { DashboardDomainCode } from './application/error-classification.js';
export { DASHBOARD_DOMAIN_CODES } from './application/error-classification.js';

/** Keep the server heartbeat comfortably below the client inactivity timeout. */
export const DASHBOARD_FEED_PING_INTERVAL_MS = 15_000;
export const DASHBOARD_FEED_INACTIVITY_RECONNECT_MS = 5 * 60_000;

/**
 * The only context needed by the finite Phase 1 router.  The callbacks keep
 * generation ownership in DashboardServerImpl; this module never creates an
 * ID or caches a snapshot.
 */
export function nativeOriginAllowed(
  origin: string | undefined,
  referer: string | undefined,
): boolean {
  if (origin === 'http://127.0.0.1:4174') return true;
  if (origin) return false;
  try {
    return new URL(referer ?? '').origin === 'http://127.0.0.1:4174';
  } catch {
    return false;
  }
}

export interface DashboardTrpcContext {
  readonly nativeOriginAllowed?: boolean;
  nativeNotifications?(): NativeNotifications | undefined;
  removePushSubscription?(endpoint: string): void;
  readonly telemetry?: DashboardTelemetry;
  readonly serverId: () => string;
  readonly snapshot: () => BrowserSnapshot;
  /** Authoritative shell query builder. */
  readonly shellSnapshot: () => unknown;
  readonly composerCommands?: (
    cwd: string,
  ) => Promise<ComposerCommandCatalogue>;
  readonly composerFileSuggestions?: (
    cwd: string,
    query: string,
  ) => Promise<ComposerFileSuggestions>;
  readonly readFile?: (request: FileReadRequest) => Promise<FileReadResult>;
  readonly sessionSnapshot?: (
    sessionId: string,
    before?: string,
  ) => Promise<AuthoritativeSessionSnapshot>;
  readonly backgroundJobs?: (
    sessionId: string,
  ) => Promise<BackgroundJobsResponse>;
  readonly backgroundJobEvents?: (
    sessionId: string,
    jobId: string,
    offset: number,
  ) => Promise<BackgroundJobEventsResponse>;
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
  /** Injected by the HTTP adapter from X-Dashboard-Protocol-Version. */
  readonly protocolVersion?: number;
}

function transportCode(
  code: DashboardDomainCode,
): 'BAD_REQUEST' | 'CONFLICT' | 'NOT_FOUND' {
  if (code === 'unknown-workspace') return 'NOT_FOUND';
  if (code === 'stale-history-cursor') return 'BAD_REQUEST';
  if (
    code === 'active-session' ||
    code === 'merge-conflict' ||
    code === 'restart-precondition' ||
    code === 'runtime-command-uncertain' ||
    code === 'idempotency-conflict' ||
    code === 'active-writer' ||
    code === 'sqlite-constraint' ||
    code === 'orchestration-conflict' ||
    code === 'session-assigned' ||
    code === 'session-link-conflict'
  )
    return 'CONFLICT';
  return 'BAD_REQUEST';
}

/** Convert domain failures without exposing database or implementation detail. */
export function toDashboardTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof FileReadError)
    return new TRPCError({
      code: error.trpcCode,
      message: error.message,
      cause: error,
    });
  const classified = classifyDashboardError(error);
  return new TRPCError({
    code: classified.code
      ? transportCode(classified.code)
      : 'INTERNAL_SERVER_ERROR',
    message: classified.message ?? 'Dashboard request failed.',
    cause: error,
  });
}

function protocolMismatch(actual: number, serverId: string): Error {
  return Object.assign(new Error('Protocol version mismatch.'), {
    code: 'protocol-mismatch',
    expected: DASHBOARD_PROTOCOL_VERSION,
    actual,
    serverId,
  });
}

function protocolMismatchDetails(error: unknown): {
  expected?: number;
  actual?: number;
  serverId?: string;
} {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const value = current as {
      expected?: unknown;
      actual?: unknown;
      serverId?: unknown;
      cause?: unknown;
    };
    if (
      typeof value.expected === 'number' &&
      typeof value.actual === 'number' &&
      typeof value.serverId === 'string'
    )
      return {
        expected: value.expected,
        actual: value.actual,
        serverId: value.serverId,
      };
    current = value.cause;
  }
  return {};
}

const t = initTRPC.context<DashboardTrpcContext>().create({
  sse: {
    ping: { enabled: true, intervalMs: DASHBOARD_FEED_PING_INTERVAL_MS },
    client: {
      reconnectAfterInactivityMs: DASHBOARD_FEED_INACTIVITY_RECONNECT_MS,
    },
  },
  errorFormatter({ shape, error }) {
    const code = classifyDashboardError(error).code;
    const mismatch =
      code === 'protocol-mismatch' ? protocolMismatchDetails(error) : {};
    return {
      ...shape,
      data: {
        ...shape.data,
        ...(code ? { domainCode: code } : {}),
        ...(code === 'protocol-mismatch' ? mismatch : {}),
      },
    };
  },
});

const protocolMiddleware = t.middleware(({ ctx, path, next }) => {
  // protocolInfo is the negotiation endpoint and must remain callable by a
  // stale client so it can report the daemon's current version and server ID.
  if (path === 'protocolInfo') return next();
  const actual = ctx.protocolVersion ?? 0;
  if (actual !== DASHBOARD_PROTOCOL_VERSION)
    throw toDashboardTrpcError(protocolMismatch(actual, ctx.serverId()));
  return next();
});
function telemetryFailure(error: TRPCError) {
  const domainCode = classifyDashboardError(error).code;
  const expected =
    !['sqlite-constraint', 'runtime-command-uncertain'].includes(
      domainCode ?? '',
    ) &&
    [
      'BAD_REQUEST',
      'CONFLICT',
      'NOT_FOUND',
      'FORBIDDEN',
      'UNAUTHORIZED',
    ].includes(error.code);
  return {
    code: domainCode ?? error.code.toLowerCase().replaceAll('_', '-'),
    outcome: expected ? ('expected' as const) : ('failure' as const),
  };
}
const telemetryMiddleware = t.middleware(async ({ ctx, path, type, next }) => {
  const started = Date.now();
  const result = await next();
  if (
    path === 'telemetryOverview' ||
    path === 'telemetryReport' ||
    type === 'subscription'
  )
    return result;
  ctx.telemetry?.record({
    operation: `rpc.${path}`,
    ...(result.ok
      ? { code: 'completed', outcome: 'success' as const }
      : telemetryFailure(result.error)),
    durationMs: Date.now() - started,
  });
  return result;
});
const dashboardProcedure = t.procedure
  .use(telemetryMiddleware)
  .use(protocolMiddleware);
const nativeProcedure = dashboardProcedure.use(({ ctx, next }) => {
  if (!ctx.nativeOriginAllowed)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Native notifications require the installed local PWA origin.',
    });
  return next();
});

function waitForBackgroundPoll(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, 250);
    const abort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', abort, { once: true });
    timer.unref?.();
  });
}

function backgroundOffsetFromEventId(
  eventId: string | undefined,
  jobId: string,
): number | undefined {
  if (!eventId) return undefined;
  const prefix = `background-log-${jobId}-`;
  if (!eventId.startsWith(prefix)) return undefined;
  const value = Number(eventId.slice(prefix.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The module-level router keeps the exported client contract concrete. */
const dashboardRouter = t.router({
  nativeControl: nativeProcedure
    .input((value: unknown) => {
      const input = value as {
        action?: unknown;
        endpoint?: unknown;
        id?: unknown;
        url?: unknown;
      } | null;
      if (
        !input ||
        !['status', 'enable', 'disable', 'ack', 'click'].includes(
          String(input.action),
        ) ||
        (input.endpoint !== undefined &&
          (typeof input.endpoint !== 'string' ||
            input.endpoint.length > 2048)) ||
        (input.id !== undefined &&
          (typeof input.id !== 'string' || input.id.length > 128)) ||
        (input.url !== undefined &&
          (typeof input.url !== 'string' || input.url.length > 2048)) ||
        (input.action === 'click' &&
          (typeof input.url !== 'string' || !nativeClickPath(input.url)))
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid native notification control.',
        });
      return input as {
        action: 'status' | 'enable' | 'disable' | 'ack' | 'click';
        endpoint?: string;
        id?: string;
        url?: string;
      };
    })
    .mutation(async ({ ctx, input }) => {
      const native = ctx.nativeNotifications?.();
      if (!native)
        return { available: false, enabled: false, permission: 'unavailable' };
      if (input.action === 'ack') {
        if (input.id) native.acknowledge(input.id);
        return {
          available: true,
          enabled: native.isEnabled(),
          permission: 'unknown',
        };
      }
      const endpoint = input.endpoint;
      return native.control(
        input.action,
        input.url,
        input.action === 'enable' && endpoint
          ? () => ctx.removePushSubscription?.(endpoint)
          : undefined,
      );
    }),
  nativeOpenExternal: nativeProcedure
    .input((value: unknown) => {
      const input = value as { url?: unknown } | null;
      if (
        !input ||
        typeof input.url !== 'string' ||
        !nativeExternalUrl(input.url)
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid external URL.',
        });
      return { url: input.url };
    })
    .mutation(async ({ ctx, input }) => {
      const native = ctx.nativeNotifications?.();
      if (!native) return { opened: false };
      const result = await native.control('openExternal', input.url);
      return { opened: result.permission === 'opened' };
    }),
  nativeClicks: nativeProcedure.subscription(async function* ({ ctx, signal }) {
    let previous: string | undefined;
    while (!signal?.aborted) {
      const click = ctx.nativeNotifications?.()?.click();
      if (click && click.id !== previous) {
        previous = click.id;
        yield { id: click.id, path: click.path };
      }
      await waitForBackgroundPoll(signal);
    }
  }),
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
  telemetryOverview: dashboardProcedure.query(({ ctx }) => {
    if (!ctx.telemetry)
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Telemetry is unavailable.',
      });
    return ctx.telemetry.overview();
  }),
  telemetryReport: dashboardProcedure
    .input((value: unknown) => {
      try {
        return parseBrowserTelemetryInput(value);
      } catch {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid telemetry report.',
        });
      }
    })
    .mutation(
      ({ ctx, input }) => ctx.telemetry?.report(input) ?? { accepted: false },
    ),
  liveDiagnostics: dashboardProcedure
    .input((value: unknown) => parseLiveDiagnosticsRequest(value))
    .output((value: unknown) => parseLiveDiagnosticsResponse(value))
    .query(({ ctx }) => {
      if (!ctx.shellFeed || !ctx.sessionFeeds)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Live diagnostics are unavailable.',
        });
      return parseLiveDiagnosticsResponse({
        shell: ctx.shellFeed.metrics(),
        sessions: ctx.sessionFeeds.metrics(),
      });
    }),
  composerCommands: dashboardProcedure
    .input((value: unknown) =>
      parseSchema(
        ComposerResourceRequestSchema,
        value,
        'composer resource request',
      ),
    )
    .output((value: unknown) =>
      parseSchema(
        ComposerCommandCatalogueSchema,
        value,
        'composer command catalogue',
      ),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.composerCommands)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Composer resources are unavailable.',
        });
      try {
        return await ctx.composerCommands(input.cwd);
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  composerFileSuggestions: dashboardProcedure
    .input((value: unknown) =>
      parseSchema(
        ComposerFileSuggestionRequestSchema,
        value,
        'composer file suggestion request',
      ),
    )
    .output((value: unknown) =>
      parseSchema(
        ComposerFileSuggestionsSchema,
        value,
        'composer file suggestions',
      ),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.composerFileSuggestions)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Composer file suggestions are unavailable.',
        });
      try {
        return await ctx.composerFileSuggestions(input.cwd, input.query);
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  readFile: dashboardProcedure
    .input((value: unknown) =>
      parseSchema(FileReadRequestSchema, value, 'file read request'),
    )
    .output((value: unknown) =>
      parseSchema(FileReadResultSchema, value, 'file read result'),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.readFile)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Host file reads are unavailable.',
        });
      try {
        return await ctx.readFile(input);
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  shellSnapshot: dashboardProcedure
    .input((value: unknown) =>
      parseSchema(ShellSnapshotRequestSchema, value, 'shell snapshot request'),
    )
    .output((value: unknown) => parseShellSnapshotResponse(value))
    .query(({ ctx, input }) => {
      if (input.protocolVersion !== DASHBOARD_PROTOCOL_VERSION)
        throw toDashboardTrpcError(
          protocolMismatch(input.protocolVersion, ctx.serverId()),
        );
      try {
        return parseShellSnapshotResponse(ctx.shellSnapshot());
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  sessionSnapshot: dashboardProcedure
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
  /** Session-scoped authoritative metadata; output text stays in the log API. */
  backgroundJobs: dashboardProcedure
    .input((value: unknown) => parseBackgroundJobsInput(value))
    .output((value: unknown) => parseBackgroundJobsResponse(value))
    .query(async ({ ctx, input }) => {
      if (!ctx.backgroundJobs)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Background jobs are unavailable.',
        });
      try {
        return parseBackgroundJobsResponse(
          await ctx.backgroundJobs(input.sessionId),
        );
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  /** Bounded on-demand line pages; clients continue from nextOffset. */
  backgroundJobEvents: dashboardProcedure
    .input((value: unknown) => parseBackgroundJobEventsInput(value))
    .output((value: unknown) => parseBackgroundJobEventsResponse(value))
    .query(async ({ ctx, input }) => {
      if (!ctx.backgroundJobEvents)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Background job logs are unavailable.',
        });
      try {
        return parseBackgroundJobEventsResponse(
          await ctx.backgroundJobEvents(
            input.sessionId,
            input.jobId,
            input.offset,
          ),
        );
      } catch (error) {
        throw toDashboardTrpcError(error);
      }
    }),
  backgroundJobsSubscribe: dashboardProcedure
    .input((value: unknown) => parseBackgroundJobsSubscribeInput(value))
    .subscription(async function* ({ ctx, input, signal }) {
      if (!ctx.backgroundJobs)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Background jobs are unavailable.',
        });
      let previous: string | undefined;
      let sequence = 0;
      while (!signal?.aborted) {
        const response = parseBackgroundJobsResponse(
          await ctx.backgroundJobs(input.sessionId),
        );
        const signature = JSON.stringify(response.jobs);
        if (signature !== previous) {
          previous = signature;
          yield tracked(
            `background-jobs-${input.sessionId}-${sequence++}`,
            response,
          );
        }
        await waitForBackgroundPoll(signal);
      }
    }),
  backgroundJobEventsSubscribe: dashboardProcedure
    .input((value: unknown) => parseBackgroundJobEventsSubscribeInput(value))
    .subscription(async function* ({ ctx, input, signal }) {
      if (!ctx.backgroundJobEvents)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Background job logs are unavailable.',
        });
      let offset =
        backgroundOffsetFromEventId(
          ctx.lastEventId ?? input.lastEventId,
          input.jobId,
        ) ?? input.offset;
      while (!signal?.aborted) {
        const response = parseBackgroundJobEventsResponse(
          await ctx.backgroundJobEvents(input.sessionId, input.jobId, offset),
        );
        if (
          response.events.length > 0 ||
          response.truncated ||
          response.complete
        )
          yield tracked(
            `background-log-${input.jobId}-${response.nextOffset}`,
            response,
          );
        offset = response.nextOffset;
        if (response.complete) return;
        await waitForBackgroundPoll(signal);
      }
    }),
  runtimeCommand: dashboardProcedure
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
  startRuntime: dashboardProcedure
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
  restartRuntime: dashboardProcedure
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
  stopRuntime: dashboardProcedure
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
  renameSession: dashboardProcedure
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
  shellSubscribe: dashboardProcedure
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
  sessionSubscribe: dashboardProcedure
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
          nativeOriginAllowed: nativeOriginAllowed(
            request.headers.origin,
            request.headers.referer,
          ),
          lastEventId:
            typeof request.headers['last-event-id'] === 'string'
              ? request.headers['last-event-id']
              : undefined,
          protocolVersion:
            typeof request.headers['x-dashboard-protocol-version'] ===
              'string' &&
            /^\d+$/.test(request.headers['x-dashboard-protocol-version'])
              ? Number(request.headers['x-dashboard-protocol-version'])
              : undefined,
        }),
        onError: ({ error, path: procedure }) => {
          if (
            procedure !== 'shellSubscribe' &&
            procedure !== 'sessionSubscribe'
          )
            return;
          const failure = telemetryFailure(error);
          const code =
            error.cause instanceof FeedOverflowError
              ? 'feed-overflow'
              : error.cause instanceof FeedPayloadTooLargeError
                ? 'feed-payload-too-large'
                : failure.code;
          context.telemetry?.record({
            operation: `rpc.${procedure}`,
            ...failure,
            code,
          });
        },
        allowMethodOverride: true,
      });
    },
  );
}
