import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, unlink } from 'node:fs/promises';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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
const READINESS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RPC_RECORD_PREFIX_CHARS = 512;
const RPC_RECORD_TYPE_PREFIX =
  /^\{(?:"id":"(?:\\.|[^"\\])*",)?"type":"([^"]+)"/u;
const RETAINED_RPC_RECORD_TYPES = new Set(['response', 'extension_ui_request']);

const READ_ONLY_TOOLS = 'read,grep,find,ls';
const LOGIN_ENV_MARKER = '\0__PI_RUNTIME_ENV_START__\0';
const execFileAsync = promisify(execFile);

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
  stdoutDiscardingLine: boolean;
  readinessId?: string;
  resolveReadiness?: () => void;
  rejectReadiness?: (error: Error) => void;
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
  'process' | 'stdoutBuffer' | 'stdoutDiscardingLine' | 'launchFingerprint'
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
    stdoutDiscardingLine: _stdoutDiscardingLine,
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
  if (!isRecord(value)) return;
  if (
    value.type === 'response' &&
    value.id === runtime.readinessId &&
    value.command === 'get_state'
  ) {
    if (value.success === true) runtime.resolveReadiness?.();
    else
      runtime.rejectReadiness?.(
        new Error('Pi rejected the runtime readiness probe.'),
      );
    return;
  }
  if (value.type !== 'extension_ui_request') return;
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
  let text = typeof chunk === 'string' ? chunk : chunk.toString();
  while (text.length > 0) {
    if (runtime.stdoutDiscardingLine) {
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      runtime.stdoutDiscardingLine = false;
      text = text.slice(newline + 1);
      continue;
    }
    const newline = text.indexOf('\n');
    const segment = newline < 0 ? text : text.slice(0, newline);
    // Pi emits canonical JSON with top-level `type` first, except responses
    // where the short correlation id comes first. The runtime host consumes
    // only responses and extension UI, so discard session events before their
    // inline images or tool output enter the bounded line buffer.
    const prefix = `${runtime.stdoutBuffer}${segment.slice(
      0,
      Math.max(0, RPC_RECORD_PREFIX_CHARS - runtime.stdoutBuffer.length),
    )}`;
    const recordType = RPC_RECORD_TYPE_PREFIX.exec(prefix)?.[1];
    if (recordType && !RETAINED_RPC_RECORD_TYPES.has(recordType)) {
      runtime.stdoutBuffer = '';
      if (newline < 0) runtime.stdoutDiscardingLine = true;
    } else if (
      Buffer.byteLength(runtime.stdoutBuffer) + Buffer.byteLength(segment) >
      RUNTIME_HOST_MAX_LINE_BYTES
    ) {
      runtime.stdoutBuffer = '';
      appendDiagnostics(runtime, 'Discarded oversized RPC stdout line.\n');
      if (newline < 0) runtime.stdoutDiscardingLine = true;
    } else if (newline < 0) runtime.stdoutBuffer += segment;
    else {
      const line = `${runtime.stdoutBuffer}${segment}`.replace(/\r$/, '');
      runtime.stdoutBuffer = '';
      if (line.length > 0) handleRpcLine(runtime, line);
    }
    if (newline < 0) return;
    text = text.slice(newline + 1);
  }
}

export function runtimeHostLocation(runtimeId: string): RuntimeLocation {
  return {
    id: `runtime-host:${runtimeId}`,
    displayTarget: `runtime-host://${runtimeId}`,
  };
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

export async function loadLoginEnvironment(
  cwd: string,
  shell = userInfo().shell,
): Promise<NodeJS.ProcessEnv> {
  const base = { ...process.env };
  if (!shell) return base;
  try {
    const { stdout } = await execFileAsync(
      shell,
      ['-lic', "printf '\\0__PI_RUNTIME_ENV_START__\\0'; /usr/bin/env -0"],
      {
        cwd,
        env: base,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
      },
    );
    const markerAt = stdout.indexOf(LOGIN_ENV_MARKER);
    if (markerAt < 0) return base;
    const environment = { ...base };
    for (const entry of stdout
      .slice(markerAt + LOGIN_ENV_MARKER.length)
      .split('\0')) {
      const separator = entry.indexOf('=');
      if (separator < 1) continue;
      const key = entry.slice(0, separator);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
      environment[key] = entry.slice(separator + 1);
    }
    return environment;
  } catch {
    // Unsupported or broken shell startup must not make managed Pi unusable.
    return base;
  }
}

async function ensureExecutable(
  executable: string,
  cwd: string,
): Promise<void> {
  const candidates = executable.includes('/')
    ? [path.resolve(cwd, executable)]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((directory) => path.resolve(directory || cwd, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return;
    } catch {
      /* try the next PATH entry */
    }
  }
  throw Object.assign(new Error(`Executable not found: ${executable}`), {
    code: 'ENOENT',
  });
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Stable owner of headless Pi processes. One instance is intended per user. */
export class RuntimeHostService {
  private readonly runtimes = new Map<string, HostRuntime>();
  private readonly startLocks = new Map<string, Promise<void>>();
  private readonly loginEnvironments = new Map<
    string,
    Promise<NodeJS.ProcessEnv>
  >();
  private server?: Server;
  private closing = false;

  constructor(
    private readonly socketPath: string,
    private readonly environmentForRuntime: (
      cwd: string,
    ) => Promise<NodeJS.ProcessEnv> = loadLoginEnvironment,
  ) {
    void this.loginEnvironment(process.cwd());
  }

  private loginEnvironment(cwd: string): Promise<NodeJS.ProcessEnv> {
    let environment = this.loginEnvironments.get(cwd);
    if (!environment) {
      environment = this.environmentForRuntime(cwd);
      this.loginEnvironments.set(cwd, environment);
    }
    return environment;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    await mkdir(path.dirname(this.socketPath), {
      recursive: true,
      mode: 0o700,
    });
    if (await socketAcceptsConnections(this.socketPath))
      throw Object.assign(new Error('Runtime host is already running.'), {
        code: 'EADDRINUSE',
      });
    await unlink(this.socketPath).catch(() => undefined);
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
    socket.on('error', () => {
      /* A malformed or disconnected client must not affect owned runtimes. */
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > RUNTIME_HOST_MAX_LINE_BYTES) {
        socket.destroy();
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
      case 'start':
        return {
          ok: true,
          runtime: summary(await this.startSerialized(request.input)),
        };
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

  private async startSerialized(input: HostStartInput): Promise<HostRuntime> {
    const runtimeId = input.runtimeId;
    const previous = this.startLocks.get(runtimeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.startLocks.set(runtimeId, current);
    await previous;
    try {
      const existing = this.runtimes.get(runtimeId);
      if (existing?.status === 'running') {
        if (!sameLaunch(existing, input))
          throw Object.assign(
            new Error('Runtime ID is already owned by a different launch.'),
            { code: 'runtime-conflict' },
          );
        return existing;
      }
      if (existing) this.runtimes.delete(runtimeId);
      const runtime = await this.startRuntime(input);
      this.runtimes.set(runtimeId, runtime);
      return runtime;
    } finally {
      release();
      if (this.startLocks.get(runtimeId) === current)
        this.startLocks.delete(runtimeId);
    }
  }

  private async startRuntime(input: HostStartInput): Promise<HostRuntime> {
    const piExecutable =
      input.piExecutable ?? process.env.PI_EXECUTABLE ?? 'pi';
    const args = buildPiArgs(input);
    await ensureExecutable(piExecutable, input.cwd);
    const loginEnvironment = await this.loginEnvironment(input.cwd);
    // The shell remains the process-group leader after exec. Its background
    // watchdog exits when Pi exits, or kills the group if the host disappears.
    const watchdog =
      'host="$PPID"; leader="$$"; (while kill -0 "$host" 2>/dev/null && kill -0 "$leader" 2>/dev/null; do sleep 0.2; done; if ! kill -0 "$host" 2>/dev/null; then kill -KILL -"$leader" 2>/dev/null || kill -KILL "$leader" 2>/dev/null; else kill -TERM -"$leader" 2>/dev/null; fi) & exec "$0" "$@"';
    const child = spawn('/bin/sh', ['-c', watchdog, piExecutable, ...args], {
      cwd: input.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...loginEnvironment,
        PWD: input.cwd,
        PI_DASHBOARD_RUNTIME_ID: input.runtimeId,
        PI_DASHBOARD_SOCKET: input.socketPath,
        PI_DASHBOARD_TOKEN: input.launchToken,
        PI_DASHBOARD_LAUNCH_TOKEN: input.launchToken,
        PI_DASHBOARD_IDENTITY_TOKEN: input.identityToken,
      },
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    if (!child.pid || !child.stdout || !child.stderr)
      throw new Error('Could not start headless Pi runtime.');
    const runtime: HostRuntime = {
      runtimeId: input.runtimeId,
      cwd: input.cwd,
      args,
      process: child,
      pid: child.pid,
      location: runtimeHostLocation(input.runtimeId),
      status: 'running',
      startedAt: Date.now(),
      diagnostics: '',
      stdoutBuffer: '',
      stdoutDiscardingLine: false,
      launchFingerprint: launchFingerprint(input),
    };
    child.stdout.on('data', (chunk) => drainStdout(runtime, chunk));
    child.stderr.on('data', (chunk) =>
      appendDiagnostics(runtime, String(chunk)),
    );
    child.stdin?.on('error', (error) =>
      appendDiagnostics(runtime, `${error.message}\n`),
    );
    child.once('close', (code, signal) => {
      runtime.status = 'stopped';
      runtime.stoppedAt = Date.now();
      runtime.exitCode = code;
      runtime.signal = signal;
      runtime.rejectReadiness?.(
        new Error('Pi exited before completing its readiness probe.'),
      );
    });
    child.on('error', (error) =>
      appendDiagnostics(runtime, `${error.message}\n`),
    );
    runtime.readinessId = `runtime-host-ready:${input.runtimeId}`;
    const readiness = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Pi readiness probe timed out.')),
        READINESS_TIMEOUT_MS,
      );
      timer.unref?.();
      runtime.resolveReadiness = () => {
        clearTimeout(timer);
        resolve();
      };
      runtime.rejectReadiness = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    writeRpcResponse(runtime, {
      id: runtime.readinessId,
      type: 'get_state',
    });
    try {
      await readiness;
    } catch (error) {
      signalGroup(runtime, 'SIGKILL');
      await waitForClose(runtime, TERM_WAIT_MS);
      throw error;
    } finally {
      runtime.readinessId = undefined;
      runtime.resolveReadiness = undefined;
      runtime.rejectReadiness = undefined;
    }
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
        if (Buffer.byteLength(buffer) > RUNTIME_HOST_MAX_LINE_BYTES) {
          clearTimeout(timer);
          connection.destroy();
          reject(new Error('Runtime host response exceeded its bound.'));
          return;
        }
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
