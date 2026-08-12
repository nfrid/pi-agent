import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type http from 'node:http';
import type { URL } from 'node:url';
import {
  type BridgeEvent,
  type BrowserSnapshot,
  isRecord,
  MAX_ID,
  type RuntimeSnapshot,
  redactImageData,
  type SessionIndexEntry,
  validateBridgeCommand,
  validateSessionRenameRequest,
  type WorkspaceTarget,
} from '@pi-dashboard/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  DashboardDependencies,
  DashboardServerOptions,
} from './composition.js';
import type { DashboardEventStreamRecord } from './event-stream.js';
import { BridgeListener } from './http/bridge-listener.js';
import { SseWriter } from './http/sse-writer.js';
import { WsCompatChannel } from './http/ws-channel.js';
import { createPushSender } from './push.js';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';
import type { RegistryChange } from './runtime-registry.js';

const NON_RENDERED_SESSION_ENTRY_TYPES = new Set([
  'session',
  'session_info',
  'model_change',
  'thinking_level_change',
  'compaction',
  'branch_summary',
  'label',
]);

function hasTranscriptEntries(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    if (!isRecord(entry) || typeof entry.type !== 'string') return true;
    return !NON_RENDERED_SESSION_ENTRY_TYPES.has(entry.type);
  });
}

function isSparseRuntimeSession(runtime: RuntimeSnapshot): boolean {
  return !hasTranscriptEntries(runtime.session.entries);
}

/**
 * Browser reducers already own runtime/transcript projections for these
 * events. Session-index metadata and most notifications remain snapshot-backed;
 * lifecycle registration/offline deltas use their small synthetic events.
 */
function requiresBrowserSnapshot(change: RegistryChange): boolean {
  if (change.kind === 'offline') return false;
  if (change.kind === 'registered') return !change.reconnected;
  switch (change.event.type) {
    case 'runtime.stateChanged':
    case 'runtime.heartbeat':
    case 'message.started':
    case 'message.updated':
    case 'message.finished':
    case 'tool.started':
    case 'tool.updated':
    case 'tool.finished':
      return false;
    case 'agent.settled':
      return process.env.PI_DASHBOARD_NOTIFY_SETTLED === '1';
    case 'session.changed':
    case 'session.snapshot':
    case 'interaction.requested':
    case 'interaction.resolved':
    case 'runtime.goodbye':
      // Session events also refresh the sessions index metadata; notification
      // unread/waiting state and runtime removal are not reduced from the event
      // envelope alone.
      return true;
    default:
      return true;
  }
}

export interface DashboardServer {
  readonly token: string;
  readonly socketPath: string;
  readonly port: number;
  readonly registry: DashboardDependencies['registry'];
  readonly manager: DashboardDependencies['manager'];
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): BrowserSnapshot;
  refreshWorkspaces(): Promise<WorkspaceTarget[]>;
  publishChange(message?: unknown): void;
  publishSessionIndexChange(): void;
}

/**
 * Thin Fastify lifecycle owner. Transport concerns live in http/bridge-listener,
 * http/sse-writer, and http/ws-channel.
 */
export class DashboardServerImpl implements DashboardServer {
  readonly token: string;
  readonly socketPath: string;
  readonly registry: DashboardDependencies['registry'];
  readonly manager: DashboardDependencies['manager'];
  port: number;
  private readonly host: string;
  private readonly origins: string[];
  private readonly stateDir: string;
  private readonly metadata: DashboardDependencies['metadata'];
  private readonly sessions: DashboardDependencies['sessions'];
  private readonly pushConfigured: boolean;
  private push: DashboardDependencies['push'];
  private readonly app: FastifyInstance;
  private readonly http: http.Server;
  private readonly bridge: BridgeListener;
  private readonly eventStream: DashboardDependencies['eventStream'];
  private readonly application: DashboardDependencies['application'];
  private readonly runtimeProvider: DashboardDependencies['runtimeProvider'];
  private readonly sse: SseWriter;
  private readonly ws: WsCompatChannel;
  private workspaces: WorkspaceTarget[] = [];
  private readonly serverId = randomBytes(12).toString('base64url');
  private revision = 0;
  private lifecycle: 'stopped' | 'starting' | 'started' | 'stopping' =
    'stopped';
  private httpHasStarted = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(dependencies: DashboardDependencies) {
    const config = dependencies.configuration;
    this.host = config.host;
    this.port = config.port;
    this.stateDir = config.stateDir;
    this.token = config.token;
    this.socketPath = config.socketPath;
    this.metadata = dependencies.metadata;
    this.sessions = dependencies.sessions;
    this.pushConfigured = dependencies.pushConfigured;
    this.push = dependencies.push;
    this.registry = dependencies.registry;
    this.manager = dependencies.manager;
    this.eventStream = dependencies.eventStream;
    this.application = dependencies.application;
    this.runtimeProvider = dependencies.runtimeProvider;
    this.origins = config.origins;

    this.bridge = new BridgeListener((socket) => this.registry.accept(socket));
    this.sse = new SseWriter({
      eventStream: this.eventStream,
      serverId: () => this.serverId,
      sseHeartbeatMs: config.sseHeartbeatMs,
      sseBufferBytes: config.sseBufferBytes,
    });
    this.ws = new WsCompatChannel({
      token: this.token,
      origins: () => this.origins,
      host: () => this.host,
      port: () => this.port,
      onAuthenticated: (client) => {
        this.ws.send(client, {
          type: 'snapshot',
          snapshot: this.snapshot(),
        });
      },
    });

    this.app = Fastify({
      logger: false,
      // Reject, rather than silently strip, bounded orchestration command
      // properties at the HTTP boundary.
      ajv: { customOptions: { removeAdditional: false } },
    });
    this.app.register(dashboardRoutes, { context: this.routeContext() });
    this.http = this.app.server;
    this.ws.attachUpgrade(this.http);
  }

  private routeContext(): DashboardRouteContext {
    return {
      token: this.token,
      origins: () => this.origins,
      snapshot: () =>
        this.application.snapshot(
          this.serverId,
          this.revision,
          this.eventStream.cursor,
        ),
      workspaces: () => this.application.workspaces.list(),
      refreshWorkspaces: () => this.refreshWorkspaces(),
      composerCommands: (workspaceId) =>
        this.application.composerCommands.forWorkspace(
          workspaceId,
          this.application.workspaces.list(),
        ),
      usage: () => this.application.usage.get(),
      readSession: (id, before) => this.sessionResult(id, before),
      renameSession: async (id, name) => {
        if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id))
          throw new Error('Invalid session id.');
        const { name: safeName } = validateSessionRenameRequest({ name });
        const runtime = this.registry
          .snapshots()
          .find((item) => item.session.id === id && item.online !== false);
        if (runtime) {
          const result = await this.application.runtime.renameSession(
            id,
            safeName,
          );
          this.changed();
          return { result };
        }
        const metadata = await this.application.runtime.renameSession(
          id,
          safeName,
        );
        this.changed();
        return { metadata };
      },
      startRuntime: async (input) => {
        const result = await this.application.runtime.launch(input);
        this.changed();
        return result;
      },
      restartRuntime: async (runtimeId, commandId) => {
        const result = await this.application.runtime.restart(
          runtimeId,
          commandId,
        );
        this.changed();
        return result;
      },
      commandRuntime: async (runtimeId, input, imageBuffers) => {
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('Invalid command body.');
        const body = input as Record<string, unknown>;
        if ('images' in body)
          throw new Error('Image paths cannot be supplied by browser clients.');
        const images =
          imageBuffers.length > 0
            ? await this.application.uploads.save(imageBuffers)
            : [];
        try {
          if (
            imageBuffers.length > 0 &&
            this.registry.get(runtimeId)?.model?.supportsImages !== true
          )
            throw new Error(
              'This runtime does not support dashboard image attachments; reload it and select an image-capable model.',
            );
          const command = validateBridgeCommand({
            ...body,
            id:
              typeof body.id === 'string' && body.id.length > 0
                ? body.id
                : randomBytes(16).toString('hex'),
            ...(images.length > 0 ? { images } : {}),
          });
          return await this.application.runtime.command(runtimeId, command);
        } finally {
          await this.application.uploads.cleanup(
            images.map((image) => image.path),
          );
        }
      },
      stopRuntime: async (runtimeId, force) => {
        await this.application.runtime.stop(runtimeId, force);
        this.changed();
      },
      interaction: (id, answer, cancel) =>
        this.application.runtime.answerInteraction(id, answer, cancel),
      markNotificationRead: (id) => {
        this.application.markNotificationRead(id);
        this.changed();
      },
      markAllNotificationsRead: () => {
        this.application.markAllNotificationsRead();
        this.changed();
      },
      pushSubscribe: (body) => this.savePushSubscription(body),
      vapidPublicKey: () => process.env.PI_DASHBOARD_VAPID_PUBLIC_KEY ?? null,
      handleSse: (request, response, url) =>
        this.handleSse(request, response, url),
      adoptProject: (command) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.adoptProject(
          command as Parameters<typeof service.adoptProject>[0],
        );
      },
      createThread: (projectId, command) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.createThread(
          projectId,
          command as Parameters<typeof service.createThread>[1],
        );
      },
      adoptSession: (projectId, sessionId, command) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.adoptSession(
          projectId,
          sessionId,
          command as Parameters<typeof service.adoptSession>[2],
        );
      },
      retryRun: (threadId, command) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.retryRun(
          threadId,
          command as Parameters<typeof service.retryRun>[1],
        );
      },
      cancelRun: (runId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.cancelRun(runId, commandId);
      },
      reviewCheckout: (checkoutId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.reviewCheckout(checkoutId);
      },
      mergeCheckout: (checkoutId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.mergeCheckout(checkoutId, commandId);
      },
      retireCheckout: (checkoutId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.retireCheckout(checkoutId, commandId);
      },
      archiveThread: (threadId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.archiveThread(threadId, commandId);
      },
    };
  }

  async start(): Promise<void> {
    if (this.lifecycle === 'started') return;
    if (this.lifecycle === 'starting') {
      await this.startPromise;
      return;
    }
    if (this.lifecycle === 'stopping') {
      await this.stopPromise;
      return this.start();
    }
    this.lifecycle = 'starting';
    const startup = this.startInternal();
    this.startPromise = startup;
    try {
      await startup;
    } finally {
      if (this.startPromise === startup) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    try {
      await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      await this.application.uploads.start();
      await this.bridge.listen(this.socketPath);
      if (this.httpHasStarted) await this.listenHttp();
      else {
        await this.app.listen({ port: this.port, host: this.host });
        this.httpHasStarted = true;
      }
      const address = this.http.address();
      if (address && typeof address === 'object') this.port = address.port;
      for (const origin of [
        `http://${this.host}:${this.port}`,
        `http://localhost:${this.port}`,
      ]) {
        if (!this.origins.includes(origin)) this.origins.push(origin);
      }
      await this.refreshWorkspaces();
      await this.sessions.start(this.workspaces);
      await this.application.orchestrationService?.start();
      if (!this.pushConfigured)
        this.push = await createPushSender(this.metadata);
      this.application.setPush(this.push);
      this.ws.startHeartbeat();
      this.lifecycle = 'started';
      // Startup callbacks are suppressed while the workspace and session
      // state is being assembled. Publish one authoritative initial snapshot.
      this.changed();
    } catch (error) {
      await this.cleanupFailedStart();
      this.lifecycle = 'stopped';
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycle === 'stopped') return;
    if (this.lifecycle === 'stopping') {
      await this.stopPromise;
      return;
    }
    if (this.lifecycle === 'starting') {
      try {
        await this.startPromise;
      } catch {
        return;
      }
      if ((this.lifecycle as string) !== 'started') return;
    }
    this.lifecycle = 'stopping';
    const shutdown = this.stopInternal();
    this.stopPromise = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.stopPromise === shutdown) this.stopPromise = undefined;
      this.lifecycle = 'stopped';
    }
  }

  private async listenHttp(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.http.off('error', onError);
        reject(error);
      };
      this.http.once('error', onError);
      this.http.listen({ port: this.port, host: this.host }, () => {
        this.http.off('error', onError);
        resolve();
      });
    });
  }

  private async stopInternal(): Promise<void> {
    this.ws.stopHeartbeat();
    await this.application.orchestrationService?.stop();
    await (
      this.runtimeProvider as DashboardDependencies['runtimeProvider'] & {
        close?: () => Promise<void>;
      }
    ).close?.();
    this.sessions.close();
    this.eventStream.close();
    this.registry.close();
    this.sse.destroyAll();
    this.ws.closeAll();
    // Destroy raw transports before waiting for their listening servers to
    // close. Otherwise a silent pre-hello bridge or open SSE can keep shutdown
    // pending indefinitely.
    this.bridge.destroyClients();
    await this.app.close();
    await this.bridge.close(this.socketPath);
    await this.application.uploads.close();
    this.push.close?.();
    this.metadata.close();
  }

  private async cleanupFailedStart(): Promise<void> {
    this.ws.stopHeartbeat();
    await this.application.orchestrationService?.stop();
    await (
      this.runtimeProvider as DashboardDependencies['runtimeProvider'] & {
        close?: () => Promise<void>;
      }
    ).close?.();
    this.sessions.close();
    this.eventStream.close();
    this.registry.close();
    this.sse.destroyAll();
    this.bridge.destroyClients();
    if (this.http.listening)
      await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await this.bridge.close(this.socketPath);
    await this.application.uploads.close().catch(() => undefined);
  }

  snapshot(cursor = this.eventStream.cursor): BrowserSnapshot {
    return this.application.snapshot(this.serverId, this.revision, cursor);
  }

  async refreshWorkspaces(): Promise<WorkspaceTarget[]> {
    const workspaces = await this.application.refreshWorkspaces();
    this.workspaces = workspaces;
    return workspaces;
  }

  private async sessionResult(id: string, before?: string): Promise<unknown> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id))
      throw new Error('Invalid session id.');
    const activeRuntime = () =>
      this.registry
        .snapshots()
        .find((item) => item.session.id === id && item.online !== false);
    const cursor = this.eventStream.cursor;
    const runtimeTransport = (runtime: RuntimeSnapshot) => {
      const provenance = this.registry.transportProvenance(runtime.runtimeId);
      return provenance && provenance.runtimeSeq >= 0 ? provenance : {};
    };
    const runtimeLeafId = (
      runtime: RuntimeSnapshot | undefined,
    ): string | undefined => {
      const leafId = runtime
        ? (runtime.session as { leafId?: unknown }).leafId
        : undefined;
      const hasControlCharacter =
        typeof leafId === 'string' &&
        [...leafId].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || code === 0x7f;
        });
      return typeof leafId === 'string' &&
        leafId.length > 0 &&
        leafId.length <= MAX_ID &&
        !hasControlCharacter
        ? leafId
        : undefined;
    };
    const runtimeResult = (runtime: RuntimeSnapshot) => {
      const entriesComplete =
        (runtime.session as { entriesComplete?: boolean }).entriesComplete ===
        true;
      return {
        serverId: this.serverId,
        cursor,
        ...runtimeTransport(runtime),
        metadata: {
          id,
          file: runtime.session.file ?? '',
          cwd: runtime.session.cwd ?? runtime.cwd,
          name: runtime.session.name,
          title: runtime.session.title,
          updatedAt: runtime.lastSeenAt ?? Date.now(),
          activeRuntimeId: runtime.runtimeId,
          entryCount: runtime.session.entries.length,
        },
        entries: redactImageData(runtime.session.entries),
        entriesComplete,
      };
    };
    const runtimeIsWorking = (runtime: RuntimeSnapshot): boolean =>
      runtime.liveState === 'working' || runtime.liveState === 'compacting';
    const sameReadAuthority = (
      left: RuntimeSnapshot | undefined,
      right: RuntimeSnapshot | undefined,
    ): boolean =>
      left?.runtimeId === right?.runtimeId &&
      left?.liveState === right?.liveState &&
      runtimeLeafId(left) === runtimeLeafId(right);
    const readForRuntime = (runtime: RuntimeSnapshot | undefined) =>
      this.sessions.readEntries(
        id,
        before,
        runtime && !runtimeIsWorking(runtime)
          ? runtimeLeafId(runtime)
          : undefined,
        {
          // A working runtime's snapshot is deliberately not authoritative:
          // emitState is only refreshed at turn boundaries. Resolve the leaf
          // from the JSONL scan that performs the read, not the file watcher.
          resolveLatestLeaf:
            before === undefined &&
            runtime !== undefined &&
            runtimeIsWorking(runtime),
        },
      );
    let runtime = before === undefined ? activeRuntime() : undefined;
    let result: Awaited<ReturnType<typeof this.sessions.readEntries>>;
    try {
      // Runtime state can change between the initial snapshot and the disk
      // read. Retry a small, bounded number of times so a working/idle switch
      // cannot select the wrong authority or branch.
      for (let attempt = 0; ; attempt += 1) {
        const runtimeNeedsBranch =
          runtime !== undefined &&
          ((runtime.session as { entriesComplete?: boolean })
            .entriesComplete !== true ||
            isSparseRuntimeSession(runtime));
        if (
          before === undefined &&
          runtime &&
          !runtimeIsWorking(runtime) &&
          runtimeNeedsBranch &&
          !runtimeLeafId(runtime)
        )
          return runtimeResult(runtime);
        if (
          before === undefined &&
          runtime &&
          !runtimeIsWorking(runtime) &&
          (runtime.session as { entriesComplete?: boolean }).entriesComplete ===
            true &&
          !isSparseRuntimeSession(runtime)
        )
          return runtimeResult(runtime);
        result = await readForRuntime(runtime);
        if (before !== undefined) break;
        const currentRuntime = activeRuntime();
        if (sameReadAuthority(runtime, currentRuntime)) {
          runtime = currentRuntime;
          break;
        }
        if (attempt >= 2) {
          // Do not attach disk entries selected under an authority that has
          // changed again. The live snapshot is the only result tied to the
          // current authority; with no live runtime, start a fresh unbranched
          // read instead of returning the mismatched branch page.
          if (currentRuntime) return runtimeResult(currentRuntime);
          result = await readForRuntime(undefined);
          runtime = undefined;
          break;
        }
        runtime = currentRuntime;
      }
      if (!runtime)
        return {
          ...result,
          serverId: this.serverId,
          cursor,
        };
      const runtimeEntriesComplete =
        (runtime.session as { entriesComplete?: boolean }).entriesComplete ===
        true;
      const withRuntimeMetadata = {
        ...result,
        // A disk page containing transcript entries is authoritative even if
        // the working snapshot has not settled. If disk only has setup data,
        // retain the incomplete live-state signal while it catches up.
        ...(runtimeIsWorking(runtime) &&
        (runtime.session as { entriesComplete?: boolean }).entriesComplete !==
          true &&
        !hasTranscriptEntries(result.entries)
          ? { entriesComplete: false }
          : {}),
        serverId: this.serverId,
        cursor,
        ...runtimeTransport(runtime),
        metadata: {
          ...result.metadata,
          ...(runtime.session.name !== undefined
            ? { name: runtime.session.name }
            : {}),
          ...(runtime.session.title !== undefined
            ? { title: runtime.session.title }
            : {}),
          activeRuntimeId: runtime.runtimeId,
        },
      };
      if (runtimeIsWorking(runtime))
        // While working, disk is authoritative even when the cached runtime
        // snapshot looks complete: it can be one or more turns behind.
        return withRuntimeMetadata;
      if (runtimeEntriesComplete && !isSparseRuntimeSession(runtime))
        return runtimeResult(runtime);
      if (runtimeEntriesComplete) {
        // A branch can be serialized successfully yet contain only session
        // settings while the indexed JSONL still has the conversation. The
        // persisted branch is the useful baseline; retain live metadata.
        return withRuntimeMetadata;
      }
      return {
        ...withRuntimeMetadata,
        // An incomplete idle snapshot still wins the optimistic projection;
        // the browser will poll until the branch is complete.
        entriesComplete: false,
      };
    } catch (error) {
      runtime = before === undefined ? activeRuntime() : undefined;
      if (!runtime) throw error;
      return runtimeResult(runtime);
    }
  }

  /** Test and route seam for the SSE transport module. */
  private handleSse(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
  ): void {
    this.sse.handle(request, response, url);
  }

  private savePushSubscription(body: unknown): void {
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as Record<string, unknown>).endpoint !== 'string' ||
      !/^https:\/\//.test((body as Record<string, unknown>).endpoint as string)
    )
      throw new Error('Invalid push subscription.');
    const now = Date.now();
    this.metadata.savePushSubscription({
      endpoint: (body as Record<string, unknown>).endpoint as string,
      subscription: body,
      createdAt: now,
      updatedAt: now,
    });
  }

  public handleRegistryChange(change: RegistryChange): void {
    const applicationChange = this.application.onRegistryChange(change);
    if (this.lifecycle !== 'started') return;
    this.changed(
      applicationChange.type === 'event'
        ? {
            ...applicationChange,
            ...(requiresBrowserSnapshot(change)
              ? { snapshot: change.snapshot }
              : {}),
          }
        : { type: 'snapshot', snapshot: this.snapshot() },
    );
  }

  public publishChange(message?: unknown): void {
    if (this.lifecycle !== 'started') return;
    this.changed(message);
  }

  public publishSessionIndexChange(): void {
    if (this.lifecycle !== 'started') return;
    this.changed({
      type: 'sessions',
      sessions: this.application.sessionMetadata(),
    });
  }

  private changed(message?: unknown): void {
    this.revision += 1;
    const record =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>)
        : undefined;
    if (record?.type === 'sessions' && Array.isArray(record.sessions)) {
      const streamRecord = this.eventStream.publish((cursor, emittedAt) => ({
        type: 'sessions' as const,
        cursor,
        emittedAt,
        sessions: record.sessions as readonly SessionIndexEntry[],
      }));
      // Preserve the legacy websocket contract; SSE/replay only receives the
      // compact typed session-index record above.
      this.ws.publish({
        type: 'snapshot',
        snapshot: this.snapshot(streamRecord.cursor),
      });
      return;
    }
    if (record?.type === 'event' && record.event) {
      const includeSnapshot =
        record.snapshot !== undefined && typeof record.snapshot === 'object';
      let streamRecord: Extract<
        DashboardEventStreamRecord,
        { event: BridgeEvent }
      >;
      try {
        streamRecord = this.eventStream.publish((cursor, emittedAt) => {
          const snapshot = includeSnapshot ? this.snapshot(cursor) : undefined;
          return {
            cursor,
            emittedAt,
            event: record.event as BridgeEvent,
            ...(record.runtimeId === undefined
              ? {}
              : { runtimeId: record.runtimeId as string }),
            ...(record.runtimeEpoch === undefined
              ? {}
              : { runtimeEpoch: record.runtimeEpoch as string }),
            ...(record.runtimeSeq === undefined
              ? {}
              : { runtimeSeq: record.runtimeSeq as number }),
            ...(record.sessionId === undefined
              ? {}
              : { sessionId: record.sessionId as string }),
            ...(snapshot === undefined ? {} : { snapshot }),
          };
        }) as Extract<DashboardEventStreamRecord, { event: BridgeEvent }>;
      } catch {
        // A malformed optional provider payload must not escape a runtime
        // callback and take down the daemon.
        return;
      }
      this.ws.publish({
        type: 'event',
        serverId: this.serverId,
        revision: this.revision,
        runtimeId:
          typeof record.runtimeId === 'string' && record.runtimeId.length > 0
            ? record.runtimeId
            : 'dashboard',
        event: record.event,
        ...(includeSnapshot && streamRecord.snapshot !== undefined
          ? { snapshot: streamRecord.snapshot }
          : {}),
      });
      return;
    }
    const streamRecord = this.eventStream.publish((cursor, emittedAt) => ({
      type: 'snapshot' as const,
      cursor,
      emittedAt,
      snapshot: this.snapshot(cursor),
    })) as Extract<DashboardEventStreamRecord, { type: 'snapshot' }>;
    this.ws.publish({
      type: 'snapshot',
      snapshot: streamRecord.snapshot,
    });
  }
}

export async function createDashboardServer(
  options: DashboardServerOptions = {},
): Promise<DashboardServer> {
  const { createDaemon } = await import('./create-daemon.js');
  return createDaemon(options);
}

export type { DashboardServerOptions } from './composition.js';
