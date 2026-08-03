import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  promises as fs,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { URL } from 'node:url';
import {
  type BrowserSnapshot,
  type NotificationEvent,
  redactImageData,
  validateBridgeCommand,
  validateSessionRenameRequest,
  validateStartRuntimeRequest,
  type WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import { MetadataStore } from './metadata.js';
import { createPushSender, type PushSender } from './push.js';
import { RuntimeManager } from './runtime-manager.js';
import { type RegistryChange, RuntimeRegistry } from './runtime-registry.js';
import { allowedOrigin, authorizeRequest, safeTokenEqual } from './security.js';
import { CliSeshAdapter, type SeshAdapter } from './sesh.js';
import { SessionIndex } from './session-index.js';
import { TmuxAdapter } from './tmux.js';
import { CodexUsageProvider, type UsageProvider } from './usage.js';

const MAX_BODY = 512 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_TOTAL_BYTES + 256 * 1024;
const MAX_IMAGE_COUNT = 4;
const MAX_WS_BUFFER = 1024 * 1024;
const MAX_USAGE_BYTES = 256 * 1024;
const USAGE_CACHE_MS = 30_000;
const WS_HEARTBEAT_MS = 30_000;
const WS_PATH = '/ws';

function loadOrCreateToken(stateDir: string): string {
  const file = path.join(stateDir, 'browser-token');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32 && existing.length <= 512) return existing;
  } catch {
    /* create below */
  }
  const token = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(file, 0o600);
    return token;
  } catch {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32 && existing.length <= 512) return existing;
    throw new Error('Could not create a stable dashboard browser token.');
  }
}

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

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  socketPath?: string;
  authToken?: string;
  origins?: readonly string[];
  stateDir?: string;
  sessionDir?: string;
  sesh?: SeshAdapter;
  tmux?: TmuxAdapter;
  metadata?: MetadataStore;
  sessions?: SessionIndex;
  registry?: RuntimeRegistry;
  usage?: UsageProvider;
  push?: PushSender;
}

export interface DashboardServer {
  readonly token: string;
  readonly socketPath: string;
  readonly port: number;
  readonly registry: RuntimeRegistry;
  readonly manager: RuntimeManager;
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): BrowserSnapshot;
  refreshWorkspaces(): Promise<WorkspaceTarget[]>;
}

class DashboardServerImpl implements DashboardServer {
  readonly token: string;
  readonly socketPath: string;
  readonly registry: RuntimeRegistry;
  readonly manager: RuntimeManager;
  port: number;
  private readonly host: string;
  private readonly origins: string[];
  private readonly stateDir: string;
  private readonly metadata: MetadataStore;
  private readonly sessions: SessionIndex;
  private readonly sesh: SeshAdapter;
  private readonly tmux: TmuxAdapter;
  private readonly usage: UsageProvider;
  private push: PushSender;
  private readonly pushConfigured: boolean;
  private readonly http: http.Server;
  private readonly bridge: net.Server;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
  });
  private readonly clients = new Set<WebSocket>();
  private readonly awaitingPong = new WeakSet<WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private sessionPublishTimer: NodeJS.Timeout | undefined;
  private workspaces: WorkspaceTarget[] = [];
  private usageSnapshot: unknown;
  private usageUpdatedAt = 0;
  private usageRequest: Promise<unknown> | undefined;
  private readonly serverId = randomBytes(12).toString('base64url');
  private revision = 0;
  private started = false;

  constructor(options: DashboardServerOptions = {}) {
    this.host = options.host ?? process.env.PI_DASHBOARD_HOST ?? '127.0.0.1';
    this.port = options.port ?? Number(process.env.PI_DASHBOARD_PORT ?? 0);
    this.stateDir =
      options.stateDir ??
      process.env.PI_DASHBOARD_STATE_DIR ??
      path.join(process.env.HOME ?? process.cwd(), '.pi', 'agent', 'dashboard');
    this.token =
      options.authToken ??
      process.env.PI_DASHBOARD_AUTH_TOKEN ??
      loadOrCreateToken(this.stateDir);
    this.socketPath =
      options.socketPath ??
      (options.stateDir
        ? path.join(this.stateDir, 'bridge.sock')
        : (process.env.PI_DASHBOARD_SOCKET ??
          path.join(this.stateDir, 'bridge.sock')));
    this.metadata =
      options.metadata ??
      new MetadataStore(path.join(this.stateDir, 'dashboard.sqlite'));
    this.sessions =
      options.sessions ??
      new SessionIndex(
        options.sessionDir ??
          process.env.PI_SESSION_DIR ??
          path.join(
            process.env.HOME ?? process.cwd(),
            '.pi',
            'agent',
            'sessions',
          ),
        this.metadata,
        () => this.scheduleSessionPublish(),
      );
    this.sesh = options.sesh ?? new CliSeshAdapter();
    this.tmux = options.tmux ?? new TmuxAdapter();
    this.usage = options.usage ?? new CodexUsageProvider();
    this.pushConfigured = Boolean(options.push);
    this.push = options.push ?? {
      async notify() {
        /* installed after start */
      },
    };
    let manager!: RuntimeManager;
    this.registry =
      options.registry ??
      new RuntimeRegistry({
        allowExternalWithoutToken: true,
        expectedToken: (runtimeId, launchToken, identityToken) =>
          manager.expectedToken(runtimeId, launchToken, identityToken),
        onChange: (change) => this.onRegistryChange(change),
      });
    this.manager = manager = new RuntimeManager(
      this.registry,
      this.tmux,
      this.sessions,
      this.metadata,
      this.socketPath,
    );
    this.origins = [...(options.origins ?? this.defaultOrigins())];
    this.bridge = net.createServer((socket) => {
      try {
        socket.setTimeout(0);
      } catch {
        /* fake sockets in tests */
      }
      this.registry.accept(socket);
    });
    this.http = http.createServer(
      (request, response) => void this.handleHttp(request, response),
    );
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

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const uploads = path.join(this.stateDir, 'uploads');
    await fs.rm(uploads, { recursive: true, force: true });
    await fs.mkdir(uploads, { recursive: true, mode: 0o700 });
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
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.http.off('error', onError);
        reject(error);
      };
      this.http.once('error', onError);
      this.http.listen(this.port, this.host, () => {
        this.http.off('error', onError);
        resolve();
      });
    });
    const address = this.http.address();
    if (address && typeof address === 'object') this.port = address.port;
    this.origins.push(
      `http://${this.host}:${this.port}`,
      `http://localhost:${this.port}`,
    );
    await this.refreshWorkspaces();
    await this.sessions.start(this.workspaces);
    if (!this.pushConfigured) this.push = await createPushSender(this.metadata);
    this.heartbeatTimer = setInterval(
      () => this.heartbeatClients(),
      WS_HEARTBEAT_MS,
    );
    this.heartbeatTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.sessionPublishTimer) clearTimeout(this.sessionPublishTimer);
    this.sessionPublishTimer = undefined;
    this.sessions.close();
    this.registry.close();
    for (const client of this.wss.clients) {
      try {
        client.close();
      } catch {
        client.terminate();
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await new Promise<void>((resolve) => this.bridge.close(() => resolve()));
    await fs.rm(this.socketPath, { force: true }).catch(() => undefined);
    this.metadata.close();
  }

  snapshot(): BrowserSnapshot {
    const liveRuntimes = this.registry.snapshots();
    const activeSessions = new Map(
      liveRuntimes
        .filter((runtime) => runtime.online !== false)
        .map((runtime) => [runtime.session.id, runtime.runtimeId]),
    );
    return {
      serverId: this.serverId,
      revision: this.revision,
      // Transcripts are served by the session endpoint and reconciled from
      // typed bridge events. Repeating them in every dashboard snapshot makes
      // live transport and browser state grow with the conversation.
      runtimes: liveRuntimes.map((runtime) => ({
        ...runtime,
        session: { ...runtime.session, entries: [] },
      })),
      workspaces: this.workspaces,
      sessions: this.sessions.list().map((session) => {
        const runtime = liveRuntimes.find(
          (item) => item.session.id === session.id && item.online !== false,
        );
        return {
          ...session,
          ...(runtime?.session.name !== undefined
            ? { name: runtime.session.name }
            : {}),
          ...(runtime?.session.title !== undefined
            ? { title: runtime.session.title }
            : {}),
          activeRuntimeId: activeSessions.get(session.id),
        };
      }),
      usage: this.usageSnapshot,
      unread: this.metadata.unreadNotifications(),
    };
  }

  async refreshWorkspaces(): Promise<WorkspaceTarget[]> {
    try {
      this.workspaces = await this.sesh.list();
      this.manager.setWorkspaces(this.workspaces);
      for (const workspace of this.workspaces)
        this.metadata.saveWorkspace(workspace);
      await this.sessions.refresh(this.workspaces);
      this.changed();
    } catch {
      // Sesh is catalogue data; losing it must not interrupt existing runtime control.
    }
    return this.workspaces;
  }

  private async handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`,
    );
    this.setCors(response, request.headers.origin);
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
    try {
      const result = await this.sessions.readEntries(id);
      if (!runtime) return this.json(response, 200, result);
      return this.json(response, 200, {
        ...result,
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
    try {
      if (
        this.usageSnapshot !== undefined &&
        Date.now() - this.usageUpdatedAt < USAGE_CACHE_MS
      )
        return this.json(response, 200, { usage: this.usageSnapshot });
      if (this.usageRequest) {
        await this.usageRequest;
        return this.json(response, 200, { usage: this.usageSnapshot });
      }
      const request = this.usage.get();
      this.usageRequest = request;
      let usage: unknown;
      try {
        usage = await request;
      } finally {
        if (this.usageRequest === request) this.usageRequest = undefined;
      }
      // Usage is an optional provider boundary. Reject values that cannot be
      // represented on the wire instead of poisoning every future snapshot.
      const serialized = JSON.stringify(usage);
      if (
        serialized === undefined ||
        Buffer.byteLength(serialized) > MAX_USAGE_BYTES
      )
        throw new Error('Usage payload exceeds the dashboard size limit.');
      this.usageSnapshot = usage;
      this.usageUpdatedAt = Date.now();
      this.changed();
      return this.json(response, 200, { usage: this.usageSnapshot });
    } catch (error) {
      return this.json(response, 200, {
        usage: this.usageSnapshot,
        error: error instanceof Error ? error.message : 'Usage unavailable.',
      });
    }
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

  private defaultOrigins(): string[] {
    return [
      `http://${this.host}:${this.port}`,
      `http://localhost:${this.port}`,
      ...(process.env.PI_DASHBOARD_ORIGINS?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean) ?? []),
    ];
  }

  private scheduleSessionPublish(): void {
    if (!this.started || this.sessionPublishTimer) return;
    this.sessionPublishTimer = setTimeout(() => {
      this.sessionPublishTimer = undefined;
      if (this.started) this.changed();
    }, 250);
    this.sessionPublishTimer.unref?.();
  }

  private onRegistryChange(change: RegistryChange): void {
    if (!isTranscriptEvent(change)) this.metadata.saveRuntime(change.snapshot);
    this.manager.onRegistryChange(change);
    if (change.kind === 'offline') {
      const runtimeId = change.snapshot.runtimeId;
      const kind =
        change.snapshot.liveState === 'failed' ? 'failed' : 'runtime-exited';
      const notification: NotificationEvent = {
        id: `${kind}-${runtimeId}-${change.snapshot.lastSeenAt ?? Date.now()}`,
        kind,
        runtimeId,
        sessionId: change.snapshot.session.id,
        title:
          kind === 'failed'
            ? 'Pi runtime failed'
            : 'Pi runtime disconnected unexpectedly',
        body:
          change.snapshot.lastError ??
          change.snapshot.session.name ??
          change.snapshot.cwd,
        createdAt: Date.now(),
      };
      this.metadata.addNotification(notification);
      void this.push.notify(notification).catch(() => undefined);
    }
    if (change.kind === 'event') {
      const event = change.event;
      if (event.type === 'interaction.resolved') {
        this.metadata.clearWaitingNotifications(change.snapshot.runtimeId);
        void this.push
          .clearWaiting?.(change.snapshot.runtimeId)
          .catch(() => undefined);
      }
      const shouldNotify =
        event.type === 'interaction.requested' ||
        event.type === 'runtime.goodbye' ||
        (event.type === 'agent.settled' &&
          process.env.PI_DASHBOARD_NOTIFY_SETTLED === '1');
      if (shouldNotify) {
        const notification: NotificationEvent = {
          id: `${event.type}-${change.snapshot.runtimeId}-${event.type === 'interaction.requested' ? event.interaction.id : Date.now()}`,
          kind:
            event.type === 'interaction.requested'
              ? 'waiting'
              : event.type === 'agent.settled'
                ? 'settled'
                : 'runtime-exited',
          runtimeId: change.snapshot.runtimeId,
          sessionId: change.snapshot.session.id,
          title:
            event.type === 'interaction.requested'
              ? 'Pi is waiting for an answer'
              : event.type === 'agent.settled'
                ? 'Pi finished a turn'
                : 'Pi runtime exited',
          body:
            event.type === 'interaction.requested'
              ? event.interaction.question
              : (change.snapshot.session.name ?? change.snapshot.cwd),
          createdAt: Date.now(),
        };
        this.metadata.addNotification(notification);
        void this.push.notify(notification).catch(() => undefined);
      }
    }
    this.changed(
      change.kind === 'event'
        ? {
            type: 'event',
            event: change.event,
            runtimeId: change.runtimeId,
            ...(isTranscriptEvent(change) ? {} : { snapshot: change.snapshot }),
          }
        : { type: 'snapshot', snapshot: this.snapshot() },
    );
  }

  private changed(message?: unknown): void {
    this.revision += 1;
    const snapshot = this.snapshot();
    if (!message) {
      this.publish({ type: 'snapshot', snapshot });
      return;
    }
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const record = message as Record<string, unknown>;
      this.publish({
        ...record,
        serverId: this.serverId,
        revision: this.revision,
        ...(record.snapshot && typeof record.snapshot === 'object'
          ? { snapshot }
          : {}),
      });
      return;
    }
    this.publish(message);
  }

  private publish(message: unknown): void {
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
  const server = new DashboardServerImpl(options);
  return server;
}

export { DashboardServerImpl };
