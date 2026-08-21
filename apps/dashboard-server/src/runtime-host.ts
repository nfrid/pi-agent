import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import path from 'node:path';
import type {
  RuntimeAttachInput,
  RuntimeBinding,
  RuntimeLocation,
  RuntimeStartInput,
} from '@pi-dashboard/protocol';

/** The host deliberately has no dashboard event or command protocol. */
export const RUNTIME_HOST_MAX_LINE_BYTES = 1024 * 1024;
export const RUNTIME_HOST_MAX_DIAGNOSTICS_BYTES = 32 * 1024;
const TERM_WAIT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

const READ_ONLY_TOOLS = 'read';

type HostStartInput = Pick<
  RuntimeStartInput,
  | 'runtimeId'
  | 'cwd'
  | 'name'
  | 'sessionFile'
  | 'model'
  | 'mode'
  | 'socketPath'
  | 'launchToken'
  | 'identityToken'
> & { piExecutable?: string };

type HostRuntime = {
  runtimeId: string;
  cwd: string;
  args: string[];
  process: ChildProcess;
  pid: number;
  location: RuntimeLocation;
  status: 'running' | 'stopped';
  startedAt: number;
  stoppedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  diagnostics: string;
  stdoutBuffer: string;
  /** Credentials are retained only in memory to reject conflicting retries. */
  launchFingerprint: string;
};

type HostRequest =
  | { op: 'start'; input: HostStartInput }
  | { op: 'list' }
  | { op: 'inspect'; runtimeId: string }
  | { op: 'attach'; runtimeId: string; location: RuntimeLocation }
  | { op: 'stop'; runtimeId: string; force?: boolean };

type HostResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  runtime?: HostRuntimeSummary;
  runtimes?: HostRuntimeSummary[];
};

export type HostRuntimeSummary = Omit<
  HostRuntime,
  'process' | 'stdoutBuffer' | 'launchFingerprint'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function errorResponse(error: unknown): HostResponse {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(isRecord(error) && typeof error.code === 'string'
      ? { code: error.code }
      : {}),
  };
}

function summary(runtime: HostRuntime): HostRuntimeSummary {
  const {
    process: _process,
    stdoutBuffer: _stdoutBuffer,
    launchFingerprint: _launchFingerprint,
    ...result
  } = runtime;
  return result;
}

function sameLaunch(runtime: HostRuntime, input: HostStartInput): boolean {
  return (
    runtime.cwd === input.cwd &&
    runtime.launchFingerprint === launchFingerprint(input)
  );
}

function launchFingerprint(input: HostStartInput): string {
  return JSON.stringify({
    cwd: input.cwd,
    args: buildPiArgs(input),
    socketPath: input.socketPath,
    launchToken: input.launchToken,
    identityToken: input.identityToken,
  });
}

function buildPiArgs(input: HostStartInput): string[] {
  const args = ['--mode', 'rpc', '--approve'];
  if (input.mode === 'read') args.push('--tools', READ_ONLY_TOOLS);
  if (input.sessionFile) args.push('--session', input.sessionFile);
  if (input.name) args.push('--name', input.name);
  if (input.model) {
    args.push('--provider', input.model.provider, '--model', input.model.model);
    if (input.model.thinking) args.push('--thinking', input.model.thinking);
  }
  return args;
}

function appendDiagnostics(runtime: HostRuntime, chunk: string): void {
  runtime.diagnostics = `${runtime.diagnostics}${chunk}`.slice(
    -RUNTIME_HOST_MAX_DIAGNOSTICS_BYTES,
  );
}

function writeRpcResponse(runtime: HostRuntime, value: unknown): void {
  if (!runtime.process.stdin || runtime.process.stdin.destroyed) return;
  try {
    runtime.process.stdin.write(jsonLine(value));
  } catch {
    /* Child close is authoritative; a closed stdin cannot be repaired. */
  }
}

function handleRpcLine(runtime: HostRuntime, line: string): void {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    appendDiagnostics(
      runtime,
      `Invalid RPC JSON line from pi: ${line.slice(0, 256)}\n`,
    );
    return;
  }
  if (!isRecord(value) || value.type !== 'extension_ui_request') return;
  // A managed runtime has no local UI. Never leave an extension request
  // waiting on a promise: cancellation is the fail-closed response.
  if (typeof value.id === 'string')
    writeRpcResponse(runtime, {
      type: 'extension_ui_response',
      id: value.id,
      cancelled: true,
    });
}

function drainStdout(runtime: HostRuntime, chunk: Buffer | string): void {
  runtime.stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
  let newline = runtime.stdoutBuffer.indexOf('\n');
  while (newline >= 0) {
    const rawLine = runtime.stdoutBuffer.slice(0, newline);
    runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newline + 1);
    if (Buffer.byteLength(rawLine) > RUNTIME_HOST_MAX_LINE_BYTES) {
      appendDiagnostics(runtime, 'RPC stdout line exceeded its bound.\n');
      runtime.process.kill('SIGTERM');
      return;
    }
    const line = rawLine.replace(/\r$/, '');
    if (line.length > 0) handleRpcLine(runtime, line);
    newline = runtime.stdoutBuffer.indexOf('\n');
  }
  if (Buffer.byteLength(runtime.stdoutBuffer) > RUNTIME_HOST_MAX_LINE_BYTES) {
    appendDiagnostics(runtime, 'RPC stdout line exceeded its bound.\n');
    runtime.process.kill('SIGTERM');
  }
}

function signalGroup(runtime: HostRuntime, signal: NodeJS.Signals): void {
  try {
    process.kill(-runtime.pid, signal);
  } catch {
    try {
      runtime.process.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

function waitForClose(runtime: HostRuntime, timeoutMs: number): Promise<void> {
  if (runtime.status === 'stopped') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    runtime.process.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    timer.unref?.();
  });
}

/** Stable owner of headless Pi processes. One instance is intended per user. */
export class RuntimeHostService {
  private readonly runtimes = new Map<string, HostRuntime>();
  private server?: Server;
  private closing = false;

  constructor(private readonly socketPath: string) {}

  async listen(): Promise<void> {
    if (this.server) return;
    await mkdir(path.dirname(this.socketPath), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await unlink(this.socketPath);
    } catch {
      /* no stale socket */
    }
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server as Server;
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const runtime of this.runtimes.values())
      await this.stopRuntime(runtime, false);
    this.runtimes.clear();
    await new Promise<void>(
      (resolve) => this.server?.close(() => resolve()) ?? resolve(),
    );
    this.server = undefined;
    await unlink(this.socketPath).catch(() => undefined);
  }

  summaries(): HostRuntimeSummary[] {
    return [...this.runtimes.values()].map(summary);
  }

  private accept(socket: Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > RUNTIME_HOST_MAX_LINE_BYTES) {
        socket.destroy(new Error('Runtime host request exceeded its bound.'));
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.handleRequest(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
  }

  private async handleRequest(socket: Socket, line: string): Promise<void> {
    let request: HostRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || typeof parsed.op !== 'string')
        throw new Error('Invalid runtime host request.');
      request = parsed as HostRequest;
    } catch (error) {
      socket.end(jsonLine(errorResponse(error)));
      return;
    }
    try {
      const response = await this.dispatch(request);
      socket.end(jsonLine(response));
    } catch (error) {
      socket.end(jsonLine(errorResponse(error)));
    }
  }

  private async dispatch(request: HostRequest): Promise<HostResponse> {
    switch (request.op) {
      case 'start': {
        const existing = this.runtimes.get(request.input.runtimeId);
        if (existing?.status === 'running') {
          if (!sameLaunch(existing, request.input))
            throw Object.assign(
              new Error('Runtime ID is already owned by a different launch.'),
              { code: 'runtime-conflict' },
            );
          return { ok: true, runtime: summary(existing) };
        }
        if (existing) this.runtimes.delete(request.input.runtimeId);
        const runtime = this.startRuntime(request.input);
        this.runtimes.set(runtime.runtimeId, runtime);
        return { ok: true, runtime: summary(runtime) };
      }
      case 'list':
        return { ok: true, runtimes: this.summaries() };
      case 'inspect': {
        const runtime = this.runtimes.get(request.runtimeId);
        return { ok: true, ...(runtime ? { runtime: summary(runtime) } : {}) };
      }
      case 'attach': {
        const runtime = this.runtimes.get(request.runtimeId);
        if (runtime?.status !== 'running')
          throw new Error('Runtime host has no running runtime with that ID.');
        if (runtime.location.id !== request.location.id)
          throw Object.assign(
            new Error('Runtime location does not match the host record.'),
            { code: 'runtime-conflict' },
          );
        return { ok: true, runtime: summary(runtime) };
      }
      case 'stop': {
        const runtime = this.runtimes.get(request.runtimeId);
        if (!runtime) return { ok: true };
        await this.stopRuntime(runtime, request.force === true);
        return { ok: true, runtime: summary(runtime) };
      }
    }
  }

  private startRuntime(input: HostStartInput): HostRuntime {
    const piExecutable =
      input.piExecutable ?? process.env.PI_EXECUTABLE ?? 'pi';
    const args = buildPiArgs(input);
    // Keep a tiny parent-death watchdog in the same process group. A normal
    // host shutdown signals this group directly; a crash/SIGKILL is noticed by
    // the watchdog and the child group is killed instead of becoming adoptable.
    const watchdog =
      'host="$PPID"; (while kill -0 "$host" 2>/dev/null; do sleep 0.2; done; kill -KILL -$$ 2>/dev/null || kill -KILL $$) & exec "$0" "$@"';
    const child = spawn('/bin/sh', ['-c', watchdog, piExecutable, ...args], {
      cwd: input.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PI_DASHBOARD_RUNTIME_ID: input.runtimeId,
        PI_DASHBOARD_SOCKET: input.socketPath,
        PI_DASHBOARD_TOKEN: input.launchToken,
        PI_DASHBOARD_LAUNCH_TOKEN: input.launchToken,
        PI_DASHBOARD_IDENTITY_TOKEN: input.identityToken,
      },
    });
    if (!child.pid || !child.stdout || !child.stderr)
      throw new Error('Could not start headless Pi runtime.');
    const runtime: HostRuntime = {
      runtimeId: input.runtimeId,
      cwd: input.cwd,
      args,
      process: child,
      pid: child.pid,
      location: {
        id: `runtime-host:${input.runtimeId}`,
        displayTarget: `runtime-host://${input.runtimeId}`,
      },
      status: 'running',
      startedAt: Date.now(),
      diagnostics: '',
      stdoutBuffer: '',
      launchFingerprint: launchFingerprint(input),
    };
    child.stdout.on('data', (chunk) => drainStdout(runtime, chunk));
    child.stderr.on('data', (chunk) =>
      appendDiagnostics(runtime, String(chunk)),
    );
    child.once('close', (code, signal) => {
      runtime.status = 'stopped';
      runtime.stoppedAt = Date.now();
      runtime.exitCode = code;
      runtime.signal = signal;
    });
    child.once('error', (error) =>
      appendDiagnostics(runtime, `${error.message}\n`),
    );
    return runtime;
  }

  private async stopRuntime(
    runtime: HostRuntime,
    force: boolean,
  ): Promise<void> {
    if (runtime.status === 'stopped') return;
    signalGroup(runtime, force ? 'SIGKILL' : 'SIGTERM');
    await waitForClose(runtime, force ? 250 : TERM_WAIT_MS);
    if ((runtime as HostRuntime).status !== 'stopped') {
      signalGroup(runtime, 'SIGKILL');
      await waitForClose(runtime, 500);
    }
  }
}

export class RuntimeHostClient {
  constructor(private readonly socketPath: string) {}

  private async request(request: HostRequest): Promise<HostResponse> {
    const connection = await new Promise<Socket>((resolve, reject) => {
      const client = createConnection(this.socketPath);
      client.once('connect', () => resolve(client));
      client.once('error', reject);
    });
    return new Promise<HostResponse>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        connection.destroy();
        reject(new Error('Runtime host request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      connection.setEncoding('utf8');
      connection.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          const value: unknown = JSON.parse(buffer.slice(0, newline));
          if (!isRecord(value) || value.ok !== true)
            throw Object.assign(
              new Error(
                String(
                  (value as Record<string, unknown>)?.error ??
                    'Runtime host request failed.',
                ),
              ),
              { code: (value as Record<string, unknown>)?.code },
            );
          resolve(value as HostResponse);
        } catch (error) {
          reject(error);
        } finally {
          connection.destroy();
        }
      });
      connection.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      connection.write(jsonLine(request));
    });
  }

  async start(input: HostStartInput): Promise<RuntimeBinding> {
    const response = await this.request({ op: 'start', input });
    if (!response.runtime) throw new Error('Runtime host returned no runtime.');
    return bindingFromSummary(response.runtime);
  }

  async list(): Promise<HostRuntimeSummary[]> {
    return (await this.request({ op: 'list' })).runtimes ?? [];
  }

  async inspect(runtimeId: string): Promise<HostRuntimeSummary | undefined> {
    return (await this.request({ op: 'inspect', runtimeId })).runtime;
  }

  async attach(input: RuntimeAttachInput): Promise<RuntimeBinding> {
    const response = await this.request({
      op: 'attach',
      runtimeId: input.runtimeId,
      location: input.location,
    });
    if (!response.runtime) throw new Error('Runtime host returned no runtime.');
    return bindingFromSummary(response.runtime);
  }

  async stop(runtimeId: string, force = false): Promise<void> {
    await this.request({ op: 'stop', runtimeId, force });
  }
}

function bindingFromSummary(runtime: HostRuntimeSummary): RuntimeBinding {
  return {
    runtimeId: runtime.runtimeId,
    location: runtime.location,
    processId: runtime.pid,
  };
}

export type { HostStartInput };
