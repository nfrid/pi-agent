import { promises as fs } from 'node:fs';
import net from 'node:net';

async function unixSocketIsLive(socketPath: string): Promise<boolean> {
  try {
    await fs.access(socketPath);
  } catch {
    return false;
  }
  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (live: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Unix-domain bridge acceptor. Tracks every raw socket so shutdown can destroy
 * pre-hello clients the registry does not yet know about.
 */
export class BridgeListener {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private boundPath: string | undefined;

  constructor(accept: (socket: net.Socket) => void) {
    this.server = net.createServer((socket) => {
      // Track the transport before RuntimeRegistry sees it. A client can be
      // connected without having sent runtime.hello yet, and registry.close()
      // only knows about authenticated runtime records.
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      try {
        socket.setTimeout(0);
      } catch {
        /* fake sockets in tests */
      }
      accept(socket);
    });
  }

  get listening(): boolean {
    return this.server.listening;
  }

  async listen(socketPath: string): Promise<void> {
    if (await unixSocketIsLive(socketPath))
      throw new Error(`Bridge socket is already in use: ${socketPath}`);
    await fs.rm(socketPath, { force: true }).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('error', onError);
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(socketPath, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    this.boundPath = socketPath;
    await fs.chmod(socketPath, 0o600).catch(() => undefined);
  }

  destroyClients(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(socketPath?: string): Promise<void> {
    const ownedPath = this.boundPath;
    this.boundPath = undefined;
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Only unlink a socket this listener actually bound. A failed start must
    // not delete another daemon's live bridge path.
    if (ownedPath && (socketPath === undefined || socketPath === ownedPath))
      await fs.rm(ownedPath, { force: true }).catch(() => undefined);
  }
}
