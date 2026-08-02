import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { URL } from 'node:url';
import {
  type BrowserSnapshot,
  type NotificationEvent,
  validateBridgeCommand,
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
const WS_PATH = '/ws';

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
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();
  private workspaces: WorkspaceTarget[] = [];
  private usageSnapshot: unknown;
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
      randomBytes(32).toString('base64url');
    this.socketPath =
      options.socketPath ??
      process.env.PI_DASHBOARD_SOCKET ??
      path.join(this.stateDir, 'bridge.sock');
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
        expectedToken: (runtimeId, token) =>
          manager.expectedToken(runtimeId, token),
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
      this.clients.add(client);
      client.once('close', () => this.clients.delete(client));
      client.send(
        JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() }),
      );
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
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
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.sessions.close();
    this.registry.close();
    for (const client of this.clients) client.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await new Promise<void>((resolve) => this.bridge.close(() => resolve()));
    await fs.rm(this.socketPath, { force: true }).catch(() => undefined);
    this.metadata.close();
  }

  snapshot(): BrowserSnapshot {
    const runtimes = this.registry.snapshots();
    const activeSessions = new Map(
      runtimes
        .filter((runtime) => runtime.online !== false)
        .map((runtime) => [runtime.session.id, runtime.runtimeId]),
    );
    return {
      revision: this.revision,
      runtimes,
      workspaces: this.workspaces,
      sessions: this.sessions.list().map((session) => ({
        ...session,
        activeRuntimeId: activeSessions.get(session.id),
      })),
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
      this.publish({ type: 'snapshot', snapshot: this.snapshot() });
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
        return this.handleUsage(response);
      if (
        request.method === 'GET' &&
        url.pathname === '/api/push/vapid-public-key'
      )
        return this.json(response, 200, {
          publicKey: process.env.PI_DASHBOARD_VAPID_PUBLIC_KEY ?? null,
        });
      if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/'))
        return this.handleSession(
          response,
          decodeURIComponent(url.pathname.slice('/api/sessions/'.length)),
        );
      if (request.method === 'POST' && url.pathname === '/api/runtimes/start')
        return this.handleStart(request, response);
      const commandMatch = url.pathname.match(
        /^\/api\/runtimes\/([^/]+)\/command$/,
      );
      if (request.method === 'POST' && commandMatch)
        return this.handleCommand(commandMatch[1], request, response);
      const stopMatch = url.pathname.match(/^\/api\/runtimes\/([^/]+)\/stop$/);
      if (request.method === 'POST' && stopMatch)
        return this.handleStop(stopMatch[1], request, response);
      const answerMatch = url.pathname.match(
        /^\/api\/interactions\/([^/]+)\/answer$/,
      );
      if (request.method === 'POST' && answerMatch)
        return this.handleInteraction(answerMatch[1], request, response, false);
      const cancelMatch = url.pathname.match(
        /^\/api\/interactions\/([^/]+)\/cancel$/,
      );
      if (request.method === 'POST' && cancelMatch)
        return this.handleInteraction(cancelMatch[1], request, response, true);
      const readMatch = url.pathname.match(
        /^\/api\/notifications\/([^/]+)\/read$/,
      );
      if (request.method === 'POST' && readMatch) {
        this.metadata.markNotificationRead(readMatch[1]);
        this.changed();
        return this.json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/push/subscribe')
        return this.handlePushSubscribe(request, response);
      return this.json(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status =
        (error as { code?: string }).code === 'shared-working-directory'
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
    const body = (await this.body(request)) as Record<string, unknown>;
    const command = validateBridgeCommand({ ...body, id: 'browser' });
    const { id: _id, ...input } = command;
    const result = await this.registry.sendCommand(runtimeId, input);
    return this.json(response, 200, { ok: true, result });
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

  private async handleSession(
    response: http.ServerResponse,
    id: string,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id))
      return this.json(response, 400, { error: 'Invalid session id.' });
    const result = await this.sessions.readEntries(id);
    return this.json(response, 200, result);
  }

  private async handleUsage(response: http.ServerResponse): Promise<void> {
    try {
      this.usageSnapshot = await this.usage.get();
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
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : undefined;
    const token = url.searchParams.get('token') ?? bearer;
    if (!safeTokenEqual(token, this.token)) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (client) =>
      this.wss.emit('connection', client, request),
    );
  }

  private async body(request: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const data = Buffer.from(chunk as Uint8Array);
      size += data.byteLength;
      if (size > MAX_BODY) throw new Error('Request body is too large.');
      chunks.push(data);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
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

  private onRegistryChange(change: RegistryChange): void {
    this.metadata.saveRuntime(change.snapshot);
    this.manager.onRegistryChange(change);
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
            snapshot: change.snapshot,
          }
        : { type: 'snapshot', snapshot: this.snapshot() },
    );
  }

  private changed(message?: unknown): void {
    this.revision += 1;
    this.publish(message ?? { type: 'snapshot', snapshot: this.snapshot() });
  }

  private publish(message: unknown): void {
    const text = JSON.stringify(message);
    for (const client of this.clients)
      if (client.readyState === client.OPEN) client.send(text);
  }
}

export async function createDashboardServer(
  options: DashboardServerOptions = {},
): Promise<DashboardServer> {
  const server = new DashboardServerImpl(options);
  return server;
}

export { DashboardServerImpl };
