import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { URL } from 'node:url';
import {
  type BridgeEvent,
  type BrowserSnapshot,
  redactImageData,
  validateBridgeCommand,
  validateSessionRenameRequest,
  validateStartRuntimeRequest,
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
import { allowedOrigin, authorizeRequest, safeTokenEqual } from './security.js';

const MAX_BODY = 512 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_TOTAL_BYTES + 256 * 1024;
const MAX_IMAGE_COUNT = 4;
const MAX_WS_BUFFER = 1024 * 1024;
const WS_HEARTBEAT_MS = 30_000;
const WS_PATH = '/ws';
const SSE_PATH = '/api/events';

function validImageDimensions(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width * height <= 40_000_000
  );
}

function validPng(data: Buffer): boolean {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (data.length < 45 || !data.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let sawHeader = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) return false;
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      if (
        !validImageDimensions(
          data.readUInt32BE(offset + 8),
          data.readUInt32BE(offset + 12),
        )
      )
        return false;
      sawHeader = true;
    }
    if (type === 'IEND') return length === 0 && end === data.length;
    offset = end;
  }
  return false;
}

function validJpeg(data: Buffer): boolean {
  if (
    data.length < 12 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data[data.length - 1] !== 0xd9
  )
    return false;
  let offset = 2;
  let hasDimensions = false;
  while (offset + 4 <= data.length - 2) {
    if (data[offset] !== 0xff) return false;
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xda) return hasDimensions;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length - 2) return false;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length - 2) return false;
    const isStartOfFrame =
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf));
    if (isStartOfFrame) {
      if (length < 7) return false;
      hasDimensions = validImageDimensions(
        data.readUInt16BE(offset + 5),
        data.readUInt16BE(offset + 3),
      );
      if (!hasDimensions) return false;
    }
    offset += length;
  }
  return false;
}

function validWebp(data: Buffer): boolean {
  if (
    data.length < 30 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.readUInt32LE(4) + 8 !== data.length ||
    data.toString('ascii', 8, 12) !== 'WEBP'
  )
    return false;
  const chunk = data.toString('ascii', 12, 16);
  const length = data.readUInt32LE(16);
  if (20 + length > data.length) return false;
  if (chunk === 'VP8X' && length >= 10) {
    const width = 1 + data.readUIntLE(24, 3);
    const height = 1 + data.readUIntLE(27, 3);
    return validImageDimensions(width, height);
  }
  if (chunk === 'VP8L' && length >= 5 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return validImageDimensions(
      1 + (bits & 0x3fff),
      1 + ((bits >> 14) & 0x3fff),
    );
  }
  if (
    chunk === 'VP8 ' &&
    length >= 10 &&
    data[23] === 0x9d &&
    data[24] === 0x01 &&
    data[25] === 0x2a
  )
    return validImageDimensions(
      data.readUInt16LE(26) & 0x3fff,
      data.readUInt16LE(28) & 0x3fff,
    );
  return false;
}

function validateImageMediaType(
  data: Buffer,
): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (validPng(data)) return 'image/png';
  if (validJpeg(data)) return 'image/jpeg';
  if (validWebp(data)) return 'image/webp';
  return undefined;
}

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
      bodyLimit: MAX_BODY,
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
            id: 'browser',
            ...(images.length > 0 ? { images } : {}),
          });
          const { id: _id, ...inputCommand } = command;
          return await this.application.runtime.command(
            runtimeId,
            inputCommand,
          );
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
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === id && item.online !== false);
    const cursor = this.eventStream.cursor;
    try {
      const result = await this.sessions.readEntries(id);
      if (!runtime) return { ...result, serverId: this.serverId, cursor };
      return {
        ...result,
        serverId: this.serverId,
        cursor,
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
      if (!runtime) throw error;
      return {
        serverId: this.serverId,
        cursor,
        metadata: {
          id,
          file: runtime.session.file ?? '',
          cwd: runtime.cwd,
          name: runtime.session.name,
          title: runtime.session.title,
          updatedAt: runtime.lastSeenAt ?? Date.now(),
          activeRuntimeId: runtime.runtimeId,
          entryCount: runtime.session.entries.length,
        },
        entries: redactImageData(runtime.session.entries),
      };
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

  // Compatibility dispatcher retained for internal callers during the route migration.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: compatibility path is intentionally not the live listener
  private async handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`,
    );
    this.setCors(response, request.headers.origin);
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'OPTIONS') {
      if (!allowedOrigin(request.headers.origin, this.origins))
        return this.json(response, 403, { error: 'Origin is not allowed.' });
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/health')
      return this.json(response, 200, { ok: true });
    const auth = authorizeRequest({
      method: request.method ?? 'GET',
      origin: request.headers.origin,
      authorization: request.headers.authorization,
      tokenHeader: request.headers['x-dashboard-token'] as string | undefined,
      expectedToken: this.token,
      allowedOrigins: this.origins,
    });
    if (!auth.ok)
      return this.json(response, auth.status, { error: auth.error });
    try {
      if (request.method === 'GET' && url.pathname === SSE_PATH)
        return this.handleSse(request, response, url);
      if (request.method === 'GET' && url.pathname === '/api/snapshot')
        return this.json(response, 200, this.snapshot());
      if (
        request.method === 'POST' &&
        url.pathname === '/api/workspaces/refresh'
      )
        return this.json(response, 200, {
          workspaces: await this.refreshWorkspaces(),
        });
      if (request.method === 'GET' && url.pathname === '/api/workspaces')
        return this.json(response, 200, { workspaces: this.workspaces });
      if (request.method === 'GET' && url.pathname === '/api/usage')
        return await this.handleUsage(response);
      if (
        request.method === 'GET' &&
        url.pathname === '/api/push/vapid-public-key'
      )
        return this.json(response, 200, {
          publicKey: process.env.PI_DASHBOARD_VAPID_PUBLIC_KEY ?? null,
        });
      const sessionNameMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/name$/,
      );
      if (request.method === 'POST' && sessionNameMatch)
        return await this.handleSessionRename(
          request,
          response,
          decodeURIComponent(sessionNameMatch[1]),
        );
      if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/'))
        return await this.handleSession(
          response,
          decodeURIComponent(url.pathname.slice('/api/sessions/'.length)),
        );
      if (request.method === 'POST' && url.pathname === '/api/runtimes/start')
        return await this.handleStart(request, response);
      const commandMatch = url.pathname.match(
        /^\/api\/runtimes\/([^/]+)\/command$/,
      );
      if (request.method === 'POST' && commandMatch)
        return await this.handleCommand(commandMatch[1], request, response);
      const stopMatch = url.pathname.match(/^\/api\/runtimes\/([^/]+)\/stop$/);
      if (request.method === 'POST' && stopMatch)
        return await this.handleStop(stopMatch[1], request, response);
      const answerMatch = url.pathname.match(
        /^\/api\/interactions\/([^/]+)\/answer$/,
      );
      if (request.method === 'POST' && answerMatch)
        return await this.handleInteraction(
          answerMatch[1],
          request,
          response,
          false,
        );
      const cancelMatch = url.pathname.match(
        /^\/api\/interactions\/([^/]+)\/cancel$/,
      );
      if (request.method === 'POST' && cancelMatch)
        return await this.handleInteraction(
          cancelMatch[1],
          request,
          response,
          true,
        );
      if (
        request.method === 'POST' &&
        url.pathname === '/api/notifications/read-all'
      ) {
        this.metadata.markAllNotificationsRead();
        this.changed();
        return this.json(response, 200, { ok: true });
      }
      const readMatch = url.pathname.match(
        /^\/api\/notifications\/([^/]+)\/read$/,
      );
      if (request.method === 'POST' && readMatch) {
        this.metadata.markNotificationRead(readMatch[1]);
        this.changed();
        return this.json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/push/subscribe')
        return await this.handlePushSubscribe(request, response);
      return this.json(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status =
        (error as { code?: string }).code === 'shared-working-directory' ||
        (error as { code?: string }).code === 'active-session'
          ? 409
          : 400;
      return this.json(response, status, {
        error: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string }).code,
      });
    }
  }

  private async handleStart(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = await this.body(request);
    const result = await this.manager.launch(validateStartRuntimeRequest(body));
    this.changed();
    return this.json(response, 201, result);
  }

  private async handleCommand(
    runtimeId: string,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const contentType = request.headers['content-type'] ?? '';
    const uploaded: string[] = [];
    let result: unknown;
    try {
      let body: Record<string, unknown>;
      let images: Array<{
        type: 'image';
        path: string;
        mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
      }> = [];
      if (contentType.startsWith('multipart/form-data;')) {
        const parsed = await this.multipartCommand(request, contentType);
        body = parsed.body;
        images = parsed.images;
        uploaded.push(...images.map((image) => image.path));
      } else {
        const value = await this.body(request);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid command body.');
        body = value as Record<string, unknown>;
      }
      if ('images' in body)
        throw new Error('Image paths cannot be supplied by browser clients.');
      if (
        images.length > 0 &&
        this.registry.get(runtimeId)?.model?.supportsImages !== true
      )
        throw new Error(
          'This runtime does not support dashboard image attachments; reload it and select an image-capable model.',
        );
      const command = validateBridgeCommand({
        ...body,
        id: 'browser',
        ...(images.length > 0 ? { images } : {}),
      });
      const { id: _id, ...input } = command;
      result = await this.registry.sendCommand(runtimeId, input);
    } finally {
      await Promise.all(uploaded.map((file) => fs.rm(file, { force: true })));
    }
    return this.json(response, 200, { ok: true, result });
  }

  private async multipartCommand(
    request: http.IncomingMessage,
    contentType: string,
  ): Promise<{
    body: Record<string, unknown>;
    images: Array<{
      type: 'image';
      path: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
    }>;
  }> {
    const raw = await this.bodyBuffer(request, MAX_MULTIPART_BYTES);
    const form = await new Response(new Uint8Array(raw), {
      headers: { 'content-type': contentType },
    }).formData();
    const commandPart = form.get('command');
    if (typeof commandPart !== 'string' || commandPart.length > MAX_BODY)
      throw new Error('Multipart command is required.');
    const parsed: unknown = JSON.parse(commandPart);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Invalid multipart command.');
    const parts = form.getAll('images');
    if (parts.length === 0 || parts.length > MAX_IMAGE_COUNT)
      throw new Error('Attach between one and four images.');
    const directory = path.join(this.stateDir, 'uploads');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const images: Array<{
      type: 'image';
      path: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
    }> = [];
    const createdPaths: string[] = [];
    try {
      let total = 0;
      for (const part of parts) {
        if (typeof part === 'string') throw new Error('Invalid image upload.');
        if (part.size === 0 || part.size > MAX_IMAGE_BYTES)
          throw new Error('Each image must be between 1 byte and 5 MiB.');
        total += part.size;
        if (total > MAX_IMAGE_TOTAL_BYTES)
          throw new Error('Image attachments exceed the 12 MiB total limit.');
        const data = Buffer.from(await part.arrayBuffer());
        const mediaType = validateImageMediaType(data);
        if (!mediaType)
          throw new Error('Only PNG, JPEG, and WebP are allowed.');
        const file = path.join(
          directory,
          `${Date.now()}-${randomBytes(16).toString('hex')}`,
        );
        createdPaths.push(file);
        await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
        images.push({ type: 'image', path: file, mediaType });
      }
      return { body: parsed as Record<string, unknown>, images };
    } catch (error) {
      await Promise.all(
        createdPaths.map((file) => fs.rm(file, { force: true })),
      );
      throw error;
    }
  }

  private async handleStop(
    runtimeId: string,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = (await this.body(request).catch(() => ({}))) as Record<
      string,
      unknown
    >;
    await this.manager.stop(runtimeId, body.force === true);
    this.changed();
    return this.json(response, 200, { ok: true });
  }

  private async handleInteraction(
    interactionId: string,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    cancel: boolean,
  ): Promise<void> {
    const body = (await this.body(request).catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const runtime = this.registry
      .snapshots()
      .find((item) =>
        item.pendingInteractions.some(
          (interaction) => interaction.id === interactionId,
        ),
      );
    if (!runtime)
      throw new Error('Interaction is already resolved or offline.');
    const result = await this.registry.sendCommand(
      runtime.runtimeId,
      cancel
        ? { type: 'interaction.cancel', interactionId }
        : { type: 'interaction.answer', interactionId, answer: body.answer },
    );
    return this.json(response, 200, { ok: true, result });
  }

  private async handleSessionRename(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    id: string,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id))
      return this.json(response, 400, { error: 'Invalid session id.' });
    const { name } = validateSessionRenameRequest(await this.body(request));
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === id && item.online !== false);
    if (runtime) {
      const result = await this.registry.sendCommand(runtime.runtimeId, {
        type: 'setSessionName',
        name,
      });
      this.changed();
      return this.json(response, 200, { ok: true, result });
    }
    const metadata = await this.sessions.rename(id, name);
    this.changed();
    return this.json(response, 200, { ok: true, metadata });
  }

  private async handleSession(
    response: http.ServerResponse,
    id: string,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id))
      return this.json(response, 400, { error: 'Invalid session id.' });
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === id && item.online !== false);
    const cursor = this.eventStream.cursor;
    try {
      const result = await this.sessions.readEntries(id);
      if (!runtime) return this.json(response, 200, { ...result, cursor });
      return this.json(response, 200, {
        ...result,
        cursor,
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
      });
    } catch (error) {
      if (!runtime) throw error;
      return this.json(response, 200, {
        cursor,
        metadata: {
          id,
          file: runtime.session.file ?? '',
          cwd: runtime.cwd,
          name: runtime.session.name,
          title: runtime.session.title,
          updatedAt: runtime.lastSeenAt ?? Date.now(),
          activeRuntimeId: runtime.runtimeId,
          entryCount: runtime.session.entries.length,
        },
        entries: redactImageData(runtime.session.entries),
      });
    }
  }

  private async handleUsage(response: http.ServerResponse): Promise<void> {
    return this.json(response, 200, await this.application.usage.get());
  }

  private async handlePushSubscribe(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = await this.body(request);
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
    return this.json(response, 201, { ok: true });
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

  private async bodyBuffer(
    request: http.IncomingMessage,
    maxBytes = MAX_BODY,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const data = Buffer.from(chunk as Uint8Array);
      size += data.byteLength;
      if (size > maxBytes) throw new Error('Request body is too large.');
      chunks.push(data);
    }
    return Buffer.concat(chunks);
  }

  private async body(request: http.IncomingMessage): Promise<unknown> {
    const data = await this.bodyBuffer(request);
    if (data.byteLength === 0) return {};
    return JSON.parse(data.toString('utf8')) as unknown;
  }

  private setCors(
    response: http.ServerResponse,
    origin: string | undefined,
  ): void {
    if (!origin || !this.origins.includes(origin)) return;
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader(
      'access-control-allow-headers',
      'authorization, content-type, x-dashboard-token',
    );
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    response.setHeader('vary', 'Origin');
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
