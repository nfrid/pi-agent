import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, unlink } from 'node:fs/promises';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import path from 'node:path';
import {
  BACKGROUND_JOBS_LIST_COMMAND_BYTES,
  BACKGROUND_JOBS_LIST_CWD_BYTES,
  BACKGROUND_JOBS_LIST_ERROR_BYTES,
  BACKGROUND_JOBS_LIST_OWNER_BYTES,
  BACKGROUND_JOBS_LIST_TITLE_BYTES,
  BACKGROUND_JOBS_MAX_LINE_BYTES,
  BACKGROUND_JOBS_MAX_OUTPUT_BYTES,
  BACKGROUND_JOBS_MAX_RESPONSE_BYTES,
  BACKGROUND_JOBS_STDERR_OUTPUT_BYTES,
  type BackgroundJobSnapshot,
  type BackgroundJobStatus,
  ensureProcessHostDirectory,
  OutputTail,
  parseBackgroundJobsRequest,
  type StartBackgroundJobInput,
} from '@pi-agent/background-jobs';
import {
  BackgroundJobStore,
  type BackgroundJobStoreRow,
} from './background-job-store.js';

const MAX_RUNNING_PER_OWNER = 8;
const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 500;

type RunningJob = {
  readonly id: string;
  readonly ownerSession: string;
  readonly child: ChildProcess;
  readonly stdout: OutputTail;
  readonly stderr: OutputTail;
  stopRequested: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
  exitCode?: number;
  signal?: string;
  error?: string;
};

type JobResponse = {
  v: 1;
  ok: boolean;
  error?: string;
  code?: string;
  job?: BackgroundJobSnapshot;
  jobs?: BackgroundJobSnapshot[];
};

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function errorResponse(error: unknown): JobResponse {
  return {
    v: 1,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(isRecord(error) && typeof error.code === 'string'
      ? { code: error.code }
      : {}),
  };
}
function fingerprint(input: StartBackgroundJobInput): string {
  return JSON.stringify({
    command: input.command,
    title: input.title,
    cwd: input.cwd,
  });
}
function snapshot(row: BackgroundJobStoreRow): BackgroundJobSnapshot {
  const { fingerprint: _fingerprint, ...result } = row;
  return result;
}
function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}…`;
}
function listSummary(row: BackgroundJobStoreRow): BackgroundJobSnapshot {
  const result = snapshot(row);
  return {
    ...result,
    ownerSession: boundedText(
      result.ownerSession,
      BACKGROUND_JOBS_LIST_OWNER_BYTES,
    ),
    title: boundedText(result.title, BACKGROUND_JOBS_LIST_TITLE_BYTES),
    command: boundedText(result.command, BACKGROUND_JOBS_LIST_COMMAND_BYTES),
    cwd: boundedText(result.cwd, BACKGROUND_JOBS_LIST_CWD_BYTES),
    ...(result.error
      ? { error: boundedText(result.error, BACKGROUND_JOBS_LIST_ERROR_BYTES) }
      : {}),
    signal: result.signal ? boundedText(result.signal, 128) : undefined,
    stdout: { ...result.stdout, text: '' },
    stderr: { ...result.stderr, text: '' },
  };
}
function processGroupSignal(
  child: ChildProcess,
  signal: NodeJS.Signals,
  directFallback = true,
): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (!directFallback) return;
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}
function waitFor(job: RunningJob, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve();
  return Promise.race([
    job.settled,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

/** Owner-only Unix-socket service for durable shell process ownership. */
export class BackgroundJobHostService {
  private store?: BackgroundJobStore;
  private server?: Server;
  private closing = false;
  private readonly jobs = new Map<string, RunningJob>();
  private readonly startLocks = new Map<string, Promise<void>>();
  private readonly cleanupHandles = new Map<
    string,
    { child: ChildProcess; timer: NodeJS.Timeout }
  >();
  private readonly databasePath: string;

  constructor(
    readonly socketPath: string,
    databasePath = path.join(
      path.dirname(socketPath),
      'background-jobs.sqlite',
    ),
  ) {
    this.databasePath = databasePath;
  }

  private database(): BackgroundJobStore {
    if (!this.store)
      throw new Error('Background process host is not listening.');
    return this.store;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    await ensureProcessHostDirectory(this.socketPath);
    if (await accepts(this.socketPath))
      throw Object.assign(
        new Error('Background process host is already running.'),
        { code: 'EADDRINUSE' },
      );
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
    // The database is opened only after the socket is exclusively owned. A
    // duplicate host therefore cannot reconcile or otherwise mutate rows.
    this.store = new BackgroundJobStore(this.databasePath);
  }

  /** Gracefully terminate all owned groups before releasing durable state. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.all([...this.startLocks.values()]);
    await Promise.all(
      [...this.jobs.values()].map((job) => this.terminate(job)),
    );
    for (const handle of this.cleanupHandles.values()) {
      clearTimeout(handle.timer);
      processGroupSignal(handle.child, 'SIGKILL');
    }
    this.cleanupHandles.clear();
    await new Promise<void>(
      (resolve) => this.server?.close(() => resolve()) ?? resolve(),
    );
    this.server = undefined;
    await unlink(this.socketPath).catch(() => undefined);
    this.store?.close();
    this.store = undefined;
  }

  private accept(socket: Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {
      /* client disconnects do not affect jobs */
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > BACKGROUND_JOBS_MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const raw = buffer.slice(0, newline);
      if (raw.trim()) void this.handle(socket, raw);
    });
  }

  private async handle(socket: Socket, raw: string): Promise<void> {
    try {
      const request = parseBackgroundJobsRequest(JSON.parse(raw));
      const response = await this.dispatch(request);
      const encoded = line(response);
      if (Buffer.byteLength(encoded) > BACKGROUND_JOBS_MAX_RESPONSE_BYTES)
        throw new Error('Background-jobs response exceeded its bound.');
      socket.end(encoded);
    } catch (error) {
      socket.end(line(errorResponse(error)));
    }
  }

  private async dispatch(
    request: ReturnType<typeof parseBackgroundJobsRequest>,
  ): Promise<JobResponse> {
    switch (request.op) {
      case 'start': {
        const job = await this.start(request.input);
        return { v: 1, ok: true, job: snapshot(job) };
      }
      case 'list':
        return {
          v: 1,
          ok: true,
          jobs: this.database().list(request.ownerSession).map(listSummary),
        };
      case 'inspect': {
        const job = this.database().get(request.ownerSession, request.id);
        return { v: 1, ok: true, ...(job ? { job: snapshot(job) } : {}) };
      }
      case 'wait': {
        const job = this.jobs.get(request.id);
        const stored = this.database().get(request.ownerSession, request.id);
        if (!stored) throw new Error(`Unknown background job "${request.id}".`);
        if (stored.status === 'running' && job)
          await waitFor(job, request.waitMs);
        const result = this.database().get(request.ownerSession, request.id);
        if (!result) throw new Error(`Unknown background job "${request.id}".`);
        return { v: 1, ok: true, job: snapshot(result) };
      }
      case 'ack':
        this.database().markDelivered(request.ownerSession, request.id);
        return { v: 1, ok: true };
      case 'stop': {
        const jobs: BackgroundJobSnapshot[] = [];
        for (const id of request.ids) {
          await this.startLocks.get(id);
          const stored = this.database().get(request.ownerSession, id);
          if (!stored) throw new Error(`Unknown background job "${id}".`);
          const running = this.jobs.get(id);
          if (running) await this.terminate(running);
          const result = this.database().get(request.ownerSession, id);
          if (result) jobs.push(snapshot(result));
        }
        return { v: 1, ok: true, jobs };
      }
    }
  }

  private async start(
    input: StartBackgroundJobInput,
  ): Promise<BackgroundJobStoreRow> {
    const previous = this.startLocks.get(input.id) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.startLocks.set(input.id, lock);
    await previous;
    try {
      if (this.closing)
        throw new Error('Background process host is shutting down.');
      const existing = this.database().getById(input.id);
      if (existing) {
        if (
          existing.ownerSession !== input.ownerSession ||
          existing.fingerprint !== fingerprint(input)
        )
          throw Object.assign(
            new Error('Job ID is already owned by a different launch.'),
            { code: 'job-conflict' },
          );
        return existing;
      }
      if (
        this.database().activeCount(input.ownerSession) >= MAX_RUNNING_PER_OWNER
      )
        throw new Error(
          `At most ${MAX_RUNNING_PER_OWNER} background jobs may run at once.`,
        );
      const row = this.database().create(input, fingerprint(input));
      let child: ChildProcess;
      try {
        const watchdog =
          'host="$PPID"; leader="$$"; (trap "" TERM; while kill -0 "$host" 2>/dev/null; do sleep 0.2; done; kill -KILL -"$leader" 2>/dev/null || kill -KILL "$leader" 2>/dev/null) </dev/null >/dev/null 2>&1 & exec "$0" "$@"';
        child = spawn(
          '/bin/sh',
          ['-c', watchdog, '/bin/bash', '-c', input.command],
          {
            cwd: input.cwd,
            env: process.env,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', () => resolve());
          child.once('error', reject);
        });
      } catch (error) {
        this.database().settle(
          input.id,
          'failed',
          { error: error instanceof Error ? error.message : String(error) },
          row.stdout,
          row.stderr,
        );
        throw error;
      }
      const running = this.makeRunning(input, child);
      this.jobs.set(input.id, running);
      this.database().setPid(input.id, child.pid ?? 0);
      this.attach(running);
      return this.database().get(
        input.ownerSession,
        input.id,
      ) as BackgroundJobStoreRow;
    } finally {
      release();
      if (this.startLocks.get(input.id) === lock)
        this.startLocks.delete(input.id);
    }
  }

  private makeRunning(
    input: StartBackgroundJobInput,
    child: ChildProcess,
  ): RunningJob {
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    return {
      id: input.id,
      ownerSession: input.ownerSession,
      child,
      stdout: new OutputTail(BACKGROUND_JOBS_MAX_OUTPUT_BYTES),
      stderr: new OutputTail(BACKGROUND_JOBS_STDERR_OUTPUT_BYTES),
      stopRequested: false,
      settled,
      resolveSettled,
    };
  }

  private attach(job: RunningJob): void {
    job.child.stdout?.setEncoding('utf8');
    job.child.stderr?.setEncoding('utf8');
    job.child.stdout?.on('data', (chunk: string) => {
      job.stdout.push(chunk);
      this.persistOutput(job);
    });
    job.child.stderr?.on('data', (chunk: string) => {
      job.stderr.push(chunk);
      this.persistOutput(job);
    });
    job.child.once('error', (error) => {
      job.error = error.message;
      void this.settle(job, 'failed');
    });
    job.child.once('exit', (code, signal) => {
      job.exitCode = code ?? undefined;
      job.signal = signal ?? undefined;
    });
    job.child.once('close', () => {
      void this.settle(
        job,
        job.stopRequested ? 'killed' : job.exitCode === 0 ? 'done' : 'failed',
      );
    });
  }

  private persistOutput(job: RunningJob): void {
    try {
      this.database().setOutput(
        job.id,
        job.stdout.snapshot(),
        job.stderr.snapshot(),
      );
    } catch {
      /* host is closing */
    }
  }

  private async settle(
    job: RunningJob,
    status: Exclude<BackgroundJobStatus, 'running'>,
  ): Promise<void> {
    if (!this.jobs.has(job.id)) return;
    this.persistOutput(job);
    this.database().settle(
      job.id,
      status,
      { exitCode: job.exitCode, signal: job.signal, error: job.error },
      job.stdout.snapshot(),
      job.stderr.snapshot(),
    );
    job.resolveSettled();
    this.jobs.delete(job.id);
    processGroupSignal(job.child, 'SIGTERM', false);
    const timer = setTimeout(() => {
      this.cleanupHandles.delete(job.id);
      processGroupSignal(job.child, 'SIGKILL', false);
    }, TERM_GRACE_MS);
    timer.unref?.();
    this.cleanupHandles.set(job.id, { child: job.child, timer });
  }

  private killCleanup(id: string): void {
    const handle = this.cleanupHandles.get(id);
    if (!handle) return;
    clearTimeout(handle.timer);
    this.cleanupHandles.delete(id);
    processGroupSignal(handle.child, 'SIGKILL', false);
  }

  private async terminate(job: RunningJob): Promise<BackgroundJobSnapshot> {
    if (!this.jobs.has(job.id))
      return snapshot(this.database().getById(job.id) as BackgroundJobStoreRow);
    job.stopRequested = true;
    processGroupSignal(job.child, 'SIGTERM');
    await waitFor(job, TERM_GRACE_MS);
    this.killCleanup(job.id);
    if (this.jobs.has(job.id)) {
      processGroupSignal(job.child, 'SIGKILL');
      await waitFor(job, KILL_GRACE_MS);
    }
    if (this.jobs.has(job.id)) {
      job.error = 'Process did not report closure after SIGKILL.';
      await this.settle(job, 'killed');
    }
    return snapshot(this.database().getById(job.id) as BackgroundJobStoreRow);
  }
}

async function accepts(socketPath: string): Promise<boolean> {
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
