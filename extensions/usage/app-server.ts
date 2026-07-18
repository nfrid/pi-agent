import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TIMEOUT_MS } from './constants';
import { normalizeAppServerResponse } from './normalize';
import type {
  AppServerResponse,
  PendingRpc,
  RpcResponse,
  UsageReport,
} from './types';

const MAX_STDERR_BYTES = 64 * 1024;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Codex app-server query aborted.');
}

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private stderrTail = Buffer.alloc(0);

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        child.kill();
        finish(abortError(signal));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(this.error('Timed out starting codex app-server.'));
      }, TIMEOUT_MS);
      signal.addEventListener('abort', onAbort, { once: true });
      child.once('spawn', () => finish());
      child.once('error', (error) => finish(error));
      child.once('exit', () => {
        const error = this.error('codex app-server exited.');
        finish(error);
        this.rejectAll(error);
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.stderrTail = Buffer.concat([this.stderrTail, bytes]).subarray(
          -MAX_STDERR_BYTES,
        );
      });
      child.stdin.on('error', (error) =>
        this.rejectAll(this.error(error.message)),
      );
      createInterface({ input: child.stdout }).on('line', (line) =>
        this.handleLine(line),
      );
    });
  }

  request(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable)
      throw new Error('codex app-server is not running.');
    signal.throwIfAborted();
    const id = this.nextId++;
    const payload =
      params === undefined ? { method, id } : { method, id, params };
    const response = new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const rejectRequest = (error: Error) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(error);
      };
      const onAbort = () => rejectRequest(abortError(signal));
      const timer = setTimeout(
        () => rejectRequest(this.error(`Timed out waiting for ${method}.`)),
        TIMEOUT_MS,
      );
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) rejectRequest(this.error(error.message));
      });
    });
    return response;
  }

  notify(method: string): void {
    this.child?.stdin.write(`${JSON.stringify({ method })}\n`, (error) => {
      if (error) this.rejectAll(this.error(error.message));
    });
  }

  dispose(): void {
    this.rejectAll(this.error('codex app-server disposed.'));
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
  }

  private error(message: string): Error {
    const stderr = this.stderrTail.toString('utf8').trim();
    return new Error(stderr ? `${message}\nCodex stderr: ${stderr}` : message);
  }

  private handleLine(line: string): void {
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (typeof parsed.id !== 'number') return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(
        this.error(String(parsed.error.message ?? 'unknown error')),
      );
    } else {
      pending.resolve(parsed.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export async function queryViaCodexAppServer(
  signal: AbortSignal,
): Promise<UsageReport> {
  const client = new CodexAppServerClient();
  try {
    await client.start(signal);
    await client.request(
      'initialize',
      {
        clientInfo: { name: 'pi_usage', title: 'Pi Usage', version: '0.1.0' },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      },
      signal,
    );
    client.notify('initialized');
    const result = await client.request(
      'account/rateLimits/read',
      undefined,
      signal,
    );
    return normalizeAppServerResponse(result as AppServerResponse);
  } finally {
    client.dispose();
  }
}
