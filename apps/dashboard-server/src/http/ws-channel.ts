import type http from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { allowedOrigin, safeTokenEqual } from '../security.js';

const MAX_WS_BUFFER = 1024 * 1024;
const WS_HEARTBEAT_MS = 30_000;
export const WS_PATH = '/ws';

export interface WsCompatChannelOptions {
  token: string;
  origins: () => readonly string[];
  host: () => string;
  port: () => number;
  /** Invoked after a client authenticates; typically sends the initial snapshot. */
  onAuthenticated: (client: WebSocket) => void;
}

/**
 * Browser WebSocket compatibility channel. Auth is the first message, never a
 * URL query value — browsers cannot set Authorization during upgrade.
 */
export class WsCompatChannel {
  private readonly token: string;
  private readonly origins: () => readonly string[];
  private readonly host: () => string;
  private readonly port: () => number;
  private readonly onAuthenticated: (client: WebSocket) => void;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
  });
  private readonly clients = new Set<WebSocket>();
  private readonly awaitingPong = new WeakSet<WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(options: WsCompatChannelOptions) {
    this.token = options.token;
    this.origins = options.origins;
    this.host = options.host;
    this.port = options.port;
    this.onAuthenticated = options.onAuthenticated;

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
        this.onAuthenticated(client);
      };
      client.once('close', () => clearTimeout(timer));
      client.once('error', () => client.terminate());
      client.on('message', authenticate);
    });
  }

  attachUpgrade(server: http.Server): void {
    server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(
      () => this.heartbeatClients(),
      WS_HEARTBEAT_MS,
    );
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  publish(message: unknown): void {
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

  send(client: WebSocket, message: unknown): boolean {
    let text: string;
    try {
      text = JSON.stringify(message);
    } catch {
      return false;
    }
    return this.sendClient(client, text);
  }

  closeAll(): void {
    this.stopHeartbeat();
    for (const client of this.wss.clients) {
      try {
        client.close();
      } catch {
        client.terminate();
      }
    }
    this.clients.clear();
  }

  private handleUpgrade(
    request: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    const url = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? `${this.host()}:${this.port()}`}`,
    );
    if (
      url.pathname !== WS_PATH ||
      !allowedOrigin(request.headers.origin, this.origins())
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
