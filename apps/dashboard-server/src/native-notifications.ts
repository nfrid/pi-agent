import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import type { NotificationEvent } from '@pi-dashboard/protocol';
import type {
  NotificationPresentation,
  PushForegroundClients,
} from './push.js';

export const NATIVE_ORIGIN = 'http://127.0.0.1:4174';
export const NATIVE_ENDPOINT = 'native:installed-pwa';
type PreferenceWriter = (directory: string, value: boolean) => Promise<void>;
async function writePreferenceAtomically(
  directory: string,
  value: boolean,
): Promise<void> {
  const target = path.join(directory, 'enabled');
  const temporary = path.join(directory, `.enabled-${randomUUID()}`);
  try {
    await writeFile(temporary, `${value}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
export function nativeClickPath(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.origin !== NATIVE_ORIGIN ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    if (url.pathname === '/') return '/';
    const match = url.pathname.match(/^\/(sessions|runtimes)\/([^/]+)$/);
    if (!match?.[2]) return;
    const id = decodeURIComponent(match[2]);
    if (
      !id ||
      Array.from(id).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return;
    return `/${match[1]}/${encodeURIComponent(id)}`;
  } catch {
    return;
  }
}

/** One API-owned helper connection and one expiring click. No browser launch flags. */
export class NativeNotifications {
  private server?: Server;
  private socket?: Socket;
  private child?: ChildProcess;
  private enabled = false;
  private closed = false;
  private enableAttempt = 0;
  private pending?: { id: string; path: string; expiresAt: number };
  private preferred = false;
  private preferenceWrites = Promise.resolve();
  private restoration?: Promise<{
    available: boolean;
    enabled: boolean;
    permission: string;
  }>;
  private requests = new Map<
    string,
    { finish: (permission: string) => void; authorizing: boolean }
  >();
  constructor(
    private readonly socketPath: string,
    private readonly executable: string,
    private readonly foreground: PushForegroundClients,
    private readonly writePreference: PreferenceWriter = writePreferenceAtomically,
  ) {}

  async start(): Promise<void> {
    if (this.closed) throw new Error('Native adapter is closed.');
    if (this.server?.listening) return;
    await mkdir(path.dirname(this.socketPath), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(path.dirname(this.socketPath), 0o700);
    const existing = await lstat(this.socketPath).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid?.())
        throw new Error('Native socket path is not an owned socket.');
      const stale = await new Promise<boolean>((resolve) => {
        const probe = connect(this.socketPath);
        probe.setTimeout(500);
        probe.once('connect', () => {
          probe.destroy();
          resolve(false);
        });
        probe.once('timeout', () => {
          probe.destroy();
          resolve(false);
        });
        probe.once('error', (error) => {
          probe.destroy();
          resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED');
        });
      });
      if (!stale) throw new Error('Native socket is already in use.');
      const current = await lstat(this.socketPath);
      if (current.ino !== existing.ino)
        throw new Error('Native socket changed during startup.');
      await unlink(this.socketPath);
    }
    const server = createServer((socket) => {
      if (this.socket) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 65536) {
          socket.destroy();
          return;
        }
        while (true) {
          const end = buffer.indexOf('\n');
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.type === 'click' && typeof message.url === 'string') {
              const target = nativeClickPath(message.url);
              if (target)
                this.pending = {
                  id: randomUUID(),
                  path: target,
                  expiresAt: Date.now() + 60000,
                };
            }
            if (message.type === 'status' && typeof message.id === 'string') {
              this.requests.get(message.id)?.finish(String(message.permission));
            }
          } catch {
            /* malformed helper message */
          }
        }
      });
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.enabled = false;
        }
      });
    });
    this.server = server;
    server.on('error', () => {
      this.enabled = false;
      this.socket?.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
    this.preferred =
      (
        await readFile(
          path.join(path.dirname(this.socketPath), 'enabled'),
          'utf8',
        ).catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        })
      ).trim() === 'true';
    if (this.preferred) await this.restore();
  }

  private persistPreference(value: boolean): Promise<void> {
    const writing = this.preferenceWrites
      .catch(() => undefined)
      .then(() => this.writePreference(path.dirname(this.socketPath), value));
    this.preferenceWrites = writing;
    return writing;
  }

  private restore() {
    if (!this.restoration)
      this.restoration = this.control('restore').finally(() => {
        this.restoration = undefined;
      });
    return this.restoration;
  }

  private launch(): void {
    if (this.socket || this.child) return;
    const child = spawn(this.executable, ['--socket', this.socketPath], {
      stdio: 'ignore',
    });
    this.child = child;
    child.on('error', () => {
      if (this.child === child) this.child = undefined;
    });
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
      this.enabled = false;
    });
  }

  async control(
    action: 'status' | 'enable' | 'disable' | 'click' | 'restore',
    url?: string,
    beforeEnable?: () => void,
  ): Promise<{ available: boolean; enabled: boolean; permission: string }> {
    if (this.closed)
      return { available: false, enabled: false, permission: 'unavailable' };
    if (action === 'click' && (!url || !nativeClickPath(url)))
      throw new Error('Invalid native click URL.');
    const attempt =
      action === 'enable' || action === 'disable'
        ? ++this.enableAttempt
        : this.enableAttempt;
    if (action === 'disable') {
      this.preferred = false;
      this.enabled = false;
      this.foreground.removeEndpoint(NATIVE_ENDPOINT);
      for (const request of this.requests.values())
        if (request.authorizing) request.finish('cancelled');
      await this.persistPreference(false);
      return { available: true, enabled: false, permission: 'disabled' };
    }
    if (action === 'status' && this.preferred && !this.enabled)
      return this.restore();
    if (action === 'status' && !this.socket)
      return { available: true, enabled: false, permission: 'notDetermined' };
    if (this.requests.size >= 8)
      return { available: true, enabled: this.enabled, permission: 'busy' };
    this.launch();
    const id = randomUUID();
    const permission = await new Promise<string>((resolve) => {
      const message = `${JSON.stringify({ type: action === 'enable' ? 'authorize' : action === 'click' ? 'click' : 'status', id, url })}\n`;
      const onConnect = (socket: Socket) => socket.write(message);
      const finish = (permission: string) => {
        clearTimeout(timer);
        this.server?.removeListener('connection', onConnect);
        this.requests.delete(id);
        resolve(permission);
      };
      const timer = setTimeout(
        () => finish('unavailable'),
        action === 'enable' ? 120000 : 3000,
      );
      this.requests.set(id, { finish, authorizing: action === 'enable' });
      // The child connects asynchronously. Send once on connection, not in a reconnect loop.
      if (this.socket) this.socket.write(message);
      else this.server?.once('connection', onConnect);
    });
    if (
      action === 'enable' &&
      permission === 'authorized' &&
      attempt === this.enableAttempt
    ) {
      await this.persistPreference(true);
      if (attempt !== this.enableAttempt)
        return { available: true, enabled: this.enabled, permission };
      try {
        beforeEnable?.();
      } catch (error) {
        this.preferred = false;
        this.enabled = false;
        await this.persistPreference(false).catch(() => undefined);
        throw error;
      }
      this.preferred = true;
      this.enabled = true;
    }
    if (action === 'restore' && attempt === this.enableAttempt)
      this.enabled = this.preferred && permission === 'authorized';
    if (action === 'status' && permission !== 'authorized')
      this.enabled = false;
    if (!this.enabled) this.foreground.removeEndpoint(NATIVE_ENDPOINT);
    return {
      available: permission !== 'unavailable',
      enabled: this.enabled,
      permission,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }
  click(): { id: string; path: string } | undefined {
    if (this.pending && this.pending.expiresAt <= Date.now())
      this.pending = undefined;
    return this.pending;
  }
  acknowledge(id: string): void {
    if (this.pending?.id === id) this.pending = undefined;
  }
  async notify(
    event: NotificationEvent,
    presentation: NotificationPresentation,
  ): Promise<void> {
    if (this.preferred && !this.enabled) await this.restore();
    if (!this.enabled || this.foreground.matches(NATIVE_ENDPOINT, event))
      return;
    if (this.socket && this.socket.writableLength > 65536) {
      this.socket.destroy();
      return;
    }
    this.socket?.write(
      `${JSON.stringify({ type: 'notify', id: event.id, title: presentation.project, subtitle: presentation.thread, body: event.kind === 'settled' ? event.body : `${event.title}\n${event.body.slice(0, 240)}`, url: NATIVE_ORIGIN + presentation.url })}\n`,
    );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.enableAttempt += 1;
    this.enabled = false;
    for (const request of this.requests.values()) request.finish('unavailable');
    this.requests.clear();
    this.socket?.destroy();
    this.child?.kill();
    this.server?.removeAllListeners('connection');
    // net.Server unlinks its owned Unix socket on close.
    this.server?.close();
  }
}
