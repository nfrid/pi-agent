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

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRpc>();

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      const timer = setTimeout(
        () => reject(new Error('Timed out starting codex app-server.')),
        TIMEOUT_MS,
      );
      child.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        this.rejectAll(new Error('codex app-server exited.'));
      });
      createInterface({ input: child.stdout }).on('line', (line) =>
        this.handleLine(line),
      );
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable)
      throw new Error('codex app-server is not running.');
    const id = this.nextId++;
    const payload =
      params === undefined ? { method, id } : { method, id, params };
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  notify(method: string): void {
    this.child?.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  dispose(): void {
    this.rejectAll(new Error('codex app-server disposed.'));
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
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
        new Error(String(parsed.error.message ?? 'unknown error')),
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

export async function queryViaCodexAppServer(): Promise<UsageReport> {
  const client = new CodexAppServerClient();
  try {
    await client.start();
    await client.request('initialize', {
      clientInfo: { name: 'pi_usage', title: 'Pi Usage', version: '0.1.0' },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    client.notify('initialized');
    const result = await client.request('account/rateLimits/read');
    return normalizeAppServerResponse(result as AppServerResponse);
  } finally {
    client.dispose();
  }
}
