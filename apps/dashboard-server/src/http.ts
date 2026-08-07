import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import {
  type BridgeEvent,
  type BrowserSnapshot,
  type RuntimeSnapshot,
  redactImageData,
  validateBridgeCommand,
  validateSessionRenameRequest,
  type WorkspaceTarget,
} from '@pi-dashboard/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import { type WebSocket, WebSocketServer } from 'ws';
import type {
  DashboardDependencies,
  DashboardServerOptions,
} from './composition.js';
import type { DashboardEventStreamRecord } from './event-stream.js';
import { createPushSender } from './push.js';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';
import type { RegistryChange } from './runtime-registry.js';
import { allowedOrigin, safeTokenEqual } from './security.js';

const MAX_WS_BUFFER = 1024 * 1024;
const WS_HEARTBEAT_MS = 30_000;
const WS_PATH = '/ws';

function isTranscriptEvent(change: RegistryChange): boolean {
  return (
    change.kind === 'event' &&
    (change.event.type.startsWith('message.') ||
      change.event.type.startsWith('tool.'))
  );
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
}

class DashboardServerImpl implements DashboardServer {
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
  private readonly bridge: net.Server;
  private readonly eventStream: DashboardDependencies['eventStream'];
  private readonly sseHeartbeatMs: number;
  private readonly sseBufferBytes: number;
  private readonly application: DashboardDependencies['application'];
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
  });
  private readonly clients = new Set<WebSocket>();
  private readonly awaitingPong = new WeakSet<WebSocket>();
  private readonly bridgeSockets = new Set<net.Socket>();
  private readonly sseResponses = new Set<http.ServerResponse>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
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
    this.sseHeartbeatMs = config.sseHeartbeatMs;
    this.sseBufferBytes = config.sseBufferBytes;
    this.application = dependencies.application;
    this.origins = config.origins;

    this.bridge = net.createServer((socket) => {
      // Track the transport before RuntimeRegistry sees it. A client can be
      // connected without having sent runtime.hello yet, and registry.close()
      // only knows about authenticated runtime records.
      this.bridgeSockets.add(socket);
      socket.once('close', () => this.bridgeSockets.delete(socket));
      try {
        socket.setTimeout(0);
      } catch {
        /* fake sockets in tests */
      }
      this.registry.accept(socket);
    });
    this.app = Fastify({
      logger: false,
    });
    this.app.register(dashboardRoutes, { context: this.routeContext() });
    this.http = this.app.server;
    this.http.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.wss.on('connection', (client) => {
      // Authentication is a bounded first message, never a URL query value.
      // Browsers cannot set Authorization during a WebSocket upgrade.
      const timer = setTimeout(
        () => client.close(1008, 'Authentication required.'),
        5_000,
      );
      const authenticate = (raw: import('ws').RawData) => {
        clearTimeout(timer);
        client.off('message', authenticate);
        let token: string;
        try {
          const message = JSON.parse(String(raw)) as {
            type?: unknown;
            token?: unknown;
          };
          if (
            message.type !== 'auth' ||
            typeof message.token !== 'string' ||
            message.token.length > 512
          )
            throw new Error('invalid');
          token = message.token;
        } catch {
          client.close(1008, 'Authentication required.');
          return;
        }
        if (!safeTokenEqual(token, this.token)) {
          client.close(1008, 'Authentication required.');
          return;
        }
        this.clients.add(client);
        client.on('pong', () => this.awaitingPong.delete(client));
        client.once('close', () => this.clients.delete(client));
        this.sendClient(
          client,
          JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() }),
        );
      };
      client.once('close', () => clearTimeout(timer));
      client.once('error', () => client.terminate());
      client.on('message', authenticate);
    });
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
      usage: () => this.application.usage.get(),
      readSession: (id) => this.sessionResult(id),
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
      await fs.rm(this.socketPath, { force: true }).catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.bridge.off('error', onError);
          reject(error);
        };
        this.bridge.once('error', onError);
        this.bridge.listen(this.socketPath, () => {
          this.bridge.off('error', onError);
          resolve();
        });
      });
      await fs.chmod(this.socketPath, 0o600).catch(() => undefined);
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
      this.heartbeatTimer = setInterval(
        () => this.heartbeatClients(),
        WS_HEARTBEAT_MS,
      );
      this.heartbeatTimer.unref?.();
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.application.orchestrationService?.stop();
    this.heartbeatTimer = undefined;
    this.sessions.close();
    this.eventStream.close();
    this.registry.close();
    for (const response of this.sseResponses) this.destroySseResponse(response);
    this.sseResponses.clear();
    for (const client of this.wss.clients) {
      try {
        client.close();
      } catch {
        client.terminate();
      }
    }
    this.clients.clear();
    // Destroy raw transports before waiting for their listening servers to
    // close. Otherwise a silent pre-hello bridge or open SSE can keep shutdown
    // pending indefinitely.
    for (const socket of this.bridgeSockets) socket.destroy();
    await this.app.close();
    if (this.bridge.listening)
      await new Promise<void>((resolve) => this.bridge.close(() => resolve()));
    await fs.rm(this.socketPath, { force: true }).catch(() => undefined);
    await this.application.uploads.close();
    this.push.close?.();
    this.metadata.close();
  }

  private async cleanupFailedStart(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.application.orchestrationService?.stop();
    this.heartbeatTimer = undefined;
    this.sessions.close();
    this.eventStream.close();
    this.registry.close();
    for (const response of this.sseResponses) this.destroySseResponse(response);
    this.sseResponses.clear();
    for (const socket of this.bridgeSockets) socket.destroy();
    if (this.http.listening)
      await new Promise<void>((resolve) => this.http.close(() => resolve()));
    if (this.bridge.listening)
      await new Promise<void>((resolve) => this.bridge.close(() => resolve()));
    await fs.rm(this.socketPath, { force: true }).catch(() => undefined);
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

  private async sessionResult(id: string): Promise<unknown> {
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
    let runtime = activeRuntime();
    if (
      runtime &&
      (runtime.session as { entriesComplete?: boolean }).entriesComplete ===
        true
    )
      return runtimeResult(runtime);
    try {
      const result = await this.sessions.readEntries(id);
      // Runtime attachment can change while the file is being read. Recheck it
      // before declaring disk history authoritative for the active branch.
      runtime = activeRuntime();
      if (!runtime)
        return {
          ...result,
          entriesComplete: true,
          serverId: this.serverId,
          cursor,
        };
      if (
        (runtime.session as { entriesComplete?: boolean }).entriesComplete ===
        true
      )
        return runtimeResult(runtime);
      return {
        ...result,
        // The JSONL may lag or represent a different active branch while the
        // runtime itself reports an incomplete snapshot. Keep polling and
        // preserve the optimistic live projection until that branch is complete.
        entriesComplete: false,
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
    } catch (error) {
      runtime = activeRuntime();
      if (!runtime) throw error;
      return runtimeResult(runtime);
    }
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

  private handleSse(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
  ): void {
    const rawCursor =
      url.searchParams.get('cursor') ??
      (typeof request.headers['last-event-id'] === 'string'
        ? request.headers['last-event-id']
        : undefined);
    const requestedCursor =
      rawCursor === undefined || rawCursor === ''
        ? this.eventStream.cursor
        : /^\d+$/u.test(rawCursor) && Number.isSafeInteger(Number(rawCursor))
          ? Number(rawCursor)
          : undefined;
    if (requestedCursor === undefined) {
      this.json(response, 400, {
        error: 'Invalid event cursor.',
        code: 'invalid-cursor',
      });
      return;
    }
    const requestedServerId = url.searchParams.get('serverId');
    if (requestedServerId && requestedServerId !== this.serverId) {
      this.json(response, 409, {
        error: 'The requested event generation is no longer available.',
        code: 'replay-gap',
        reason: 'server-generation-mismatch',
        serverId: this.serverId,
        cursor: this.eventStream.cursor,
        oldestCursor: this.eventStream.oldestCursor,
      });
      return;
    }
    const replay = this.eventStream.replayAfter(requestedCursor);
    if (replay.gap) {
      this.json(response, 409, {
        error: 'The requested event cursor is no longer available.',
        code: 'replay-gap',
        cursor: replay.currentCursor,
        oldestCursor: replay.oldestCursor,
      });
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders?.();
    this.sseResponses.add(response);
    let closed = false;
    let replaying = true;
    const queued: DashboardEventStreamRecord[] = [];
    let queuedBytes = 0;
    const pendingWrites: string[] = [];
    let pendingBytes = 0;
    let backpressured = false;
    let drainAttached = false;
    let unsubscribe: () => void = () => undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.sseResponses.delete(response);
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      if (drainAttached) response.off('drain', flushWrites);
      pendingWrites.length = 0;
      pendingBytes = 0;
    };
    const closeSlowClient = () => {
      cleanup();
      if (!response.writableEnded) response.destroy();
    };
    const flushWrites = () => {
      if (closed || response.writableEnded) return;
      backpressured = false;
      drainAttached = false;
      while (pendingWrites.length > 0) {
        const value = pendingWrites[0];
        const bytes = Buffer.byteLength(value);
        if (response.writableLength + bytes > this.sseBufferBytes) {
          backpressured = true;
          if (!drainAttached) {
            drainAttached = true;
            response.once('drain', flushWrites);
          }
          return;
        }
        try {
          pendingWrites.shift();
          pendingBytes -= bytes;
          if (!response.write(value)) {
            backpressured = true;
            if (!drainAttached) {
              drainAttached = true;
              response.once('drain', flushWrites);
            }
            return;
          }
        } catch {
          closeSlowClient();
          return;
        }
      }
    };
    const writeRaw = (value: string): boolean => {
      if (closed || response.writableEnded) return false;
      const bytes = Buffer.byteLength(value);
      if (bytes > this.sseBufferBytes) {
        closeSlowClient();
        return false;
      }
      if (backpressured || pendingWrites.length > 0) {
        if (
          response.writableLength + pendingBytes + bytes >
          this.sseBufferBytes
        ) {
          closeSlowClient();
          return false;
        }
        pendingWrites.push(value);
        pendingBytes += bytes;
        return true;
      }
      if (response.writableLength + bytes > this.sseBufferBytes) {
        closeSlowClient();
        return false;
      }
      try {
        if (!response.write(value)) {
          backpressured = true;
          if (!drainAttached) {
            drainAttached = true;
            response.once('drain', flushWrites);
          }
        }
        return true;
      } catch {
        closeSlowClient();
        return false;
      }
    };
    const writeRecord = (record: DashboardEventStreamRecord): boolean => {
      const text = JSON.stringify(record);
      return writeRaw(
        `id: ${record.cursor}\nevent: dashboard\ndata: ${text}\n\n`,
      );
    };
    const writeHeartbeat = () => writeRaw(': heartbeat\n\n');
    const onRecord = (record: DashboardEventStreamRecord) => {
      if (replaying) {
        const bytes =
          Buffer.byteLength(JSON.stringify(record)) +
          Buffer.byteLength(
            `id: ${record.cursor}\nevent: dashboard\ndata: \n\n`,
          );
        if (queuedBytes + bytes > this.sseBufferBytes) return closeSlowClient();
        queued.push(record);
        queuedBytes += bytes;
        return;
      }
      writeRecord(record);
    };
    unsubscribe = this.eventStream.subscribe(onRecord);
    response.once('close', cleanup);
    request.once('aborted', cleanup);
    if (!writeHeartbeat()) return;
    for (const record of replay.events) {
      if (!writeRecord(record)) return;
    }
    replaying = false;
    for (const record of queued) {
      if (!writeRecord(record)) return;
    }
    heartbeat = setInterval(
      writeHeartbeat,
      Math.max(1_000, this.sseHeartbeatMs),
    );
    heartbeat.unref?.();
  }

  private json(
    response: http.ServerResponse,
    status: number,
    value: unknown,
  ): void {
    const text = JSON.stringify(value);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(text);
  }

  private destroySseResponse(response: http.ServerResponse): void {
    if (response.writableEnded) return;
    try {
      response.destroy();
    } catch {
      try {
        response.end();
      } catch {
        /* best effort during shutdown */
      }
    }
  }

  private handleUpgrade(
    request: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    const url = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`,
    );
    if (
      url.pathname !== WS_PATH ||
      !allowedOrigin(request.headers.origin, this.origins)
    ) {
      socket.destroy();
      return;
    }
    // Upgrade authentication is completed by the first WebSocket message.
    // Do not accept query-string or upgrade-header tokens: URLs are routinely
    // logged by browsers, proxies, analytics and reverse proxies.
    this.wss.handleUpgrade(request, socket, head, (client) =>
      this.wss.emit('connection', client, request),
    );
  }

  public handleRegistryChange(change: RegistryChange): void {
    const applicationChange = this.application.onRegistryChange(change);
    if (this.lifecycle !== 'started') return;
    this.changed(
      applicationChange.type === 'event'
        ? {
            ...applicationChange,
            ...(isTranscriptEvent(change) ? {} : { snapshot: change.snapshot }),
          }
        : { type: 'snapshot', snapshot: this.snapshot() },
    );
  }

  public publishChange(message?: unknown): void {
    if (this.lifecycle !== 'started') return;
    this.changed(message);
  }

  private changed(message?: unknown): void {
    this.revision += 1;
    const record =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>)
        : undefined;
    if (record?.type === 'event' && record.event) {
      const includeSnapshot =
        record.snapshot !== undefined && typeof record.snapshot === 'object';
      let streamRecord: DashboardEventStreamRecord;
      try {
        streamRecord = this.eventStream.publish((cursor, emittedAt) => ({
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
          ...(includeSnapshot ? { snapshot: this.snapshot(cursor) } : {}),
        }));
      } catch {
        // A malformed optional provider payload must not escape a runtime
        // callback and take down the daemon.
        return;
      }
      this.publishLegacy({
        ...record,
        serverId: this.serverId,
        revision: this.revision,
        ...(includeSnapshot
          ? { snapshot: this.snapshot(streamRecord.cursor) }
          : {}),
      });
      return;
    }
    const streamRecord = this.eventStream.publish((cursor, emittedAt) => ({
      type: 'snapshot',
      cursor,
      emittedAt,
      snapshot: this.snapshot(cursor),
    }));
    this.publishLegacy({
      type: 'snapshot',
      snapshot: this.snapshot(streamRecord.cursor),
    });
  }

  private publishLegacy(message: unknown): void {
    let text: string;
    try {
      text = JSON.stringify(message);
    } catch {
      // A bad optional provider payload must not escape an event callback and
      // take down the daemon. The next valid change remains publishable.
      return;
    }
    for (const client of this.clients) this.sendClient(client, text);
  }

  private heartbeatClients(): void {
    for (const client of this.clients) {
      if (client.readyState !== client.OPEN) {
        this.clients.delete(client);
        continue;
      }
      if (this.awaitingPong.has(client)) {
        this.clients.delete(client);
        client.terminate();
        continue;
      }
      this.awaitingPong.add(client);
      try {
        client.ping();
      } catch {
        this.clients.delete(client);
        client.terminate();
      }
    }
  }

  private sendClient(client: WebSocket, text: string): boolean {
    if (client.readyState !== client.OPEN) return false;
    const bytes = Buffer.byteLength(text);
    if (
      bytes > MAX_WS_BUFFER ||
      client.bufferedAmount + bytes > MAX_WS_BUFFER
    ) {
      this.clients.delete(client);
      client.terminate();
      return false;
    }
    try {
      client.send(text, (error) => {
        if (!error) return;
        this.clients.delete(client);
        client.terminate();
      });
      return true;
    } catch {
      this.clients.delete(client);
      client.terminate();
      return false;
    }
  }
}

export async function createDashboardServer(
  options: DashboardServerOptions = {},
): Promise<DashboardServer> {
  const { createDaemon } = await import('./create-daemon.js');
  return createDaemon(options);
}

export type { DashboardServerOptions } from './composition.js';
export { DashboardServerImpl };
