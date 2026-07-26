import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { waitFor, withAbort } from '../shared/runtime/async';
import { type OutputSnapshot, OutputTail } from './output';

export const MAX_RUNNING = 8;
export const MAX_SETTLED = 32;
export const STDOUT_RETAINED_BYTES = 256 * 1024;
export const STDERR_RETAINED_BYTES = 128 * 1024;
const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 500;
const DISPLAY_COMMAND_CHARS = 1_000;

export type BackgroundStatus = 'running' | 'done' | 'failed' | 'killed';

export interface BackgroundSnapshot {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly cwd: string;
  readonly pid?: number;
  readonly status: BackgroundStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly error?: string;
  readonly stdout: OutputSnapshot;
  readonly stderr: OutputSnapshot;
}

export interface StartOptions {
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
}

interface ProcessRecord {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly child: ChildProcess;
  readonly stdout: OutputTail;
  readonly stderr: OutputTail;
  readonly settled: Promise<void>;
  resolveSettled: () => void;
  status: BackgroundStatus;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
  stopRequested: boolean;
  observers: number;
}

export interface BackgroundManagerOptions {
  readonly onSettled?: (snapshot: BackgroundSnapshot) => void;
  readonly onChange?: () => void;
}

function displayCommand(command: string): string {
  return command.length <= DISPLAY_COMMAND_CHARS
    ? command
    : `${command.slice(0, DISPLAY_COMMAND_CHARS)}…`;
}

function shellInvocation(command: string): [string, string[]] {
  return [
    process.platform === 'win32' ? 'bash.exe' : '/bin/bash',
    ['-c', command],
  ];
}

function signalTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  directFallback = true,
): void {
  if (!child.pid) return;

  if (process.platform === 'win32') {
    const taskkill = spawn(
      'taskkill',
      [
        '/pid',
        String(child.pid),
        '/t',
        ...(signal === 'SIGKILL' ? ['/f'] : []),
      ],
      { stdio: 'ignore' },
    );
    taskkill.on('error', () => {});
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    if (!directFallback) return;
    try {
      child.kill(signal);
    } catch {
      // The process exited between the status check and signal delivery.
    }
  }
}

export class BackgroundManager {
  private readonly records = new Map<string, ProcessRecord>();
  private readonly cleanupTimers = new Map<ProcessRecord, NodeJS.Timeout>();
  private readonly onSettled?: (snapshot: BackgroundSnapshot) => void;
  private readonly onChange?: () => void;
  private counter = 0;
  private disposed = false;

  constructor(options: BackgroundManagerOptions = {}) {
    this.onSettled = options.onSettled;
    this.onChange = options.onChange;
  }

  start(options: StartOptions): BackgroundSnapshot {
    if (this.disposed) throw new Error('Background manager is shutting down.');
    if (this.runningCount >= MAX_RUNNING) {
      throw new Error(
        `At most ${MAX_RUNNING} background processes may run at once.`,
      );
    }

    const id = `bg-${++this.counter}`;
    const [shell, args] = shellInvocation(options.command);
    const child = spawn(shell, args, {
      cwd: options.cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolveSettled = () => {};
    const settled = new Promise<void>((resolvePromise) => {
      resolveSettled = resolvePromise;
    });
    const record: ProcessRecord = {
      id,
      title: options.title,
      command: displayCommand(options.command),
      cwd: resolve(options.cwd),
      createdAt: Date.now(),
      child,
      stdout: new OutputTail(STDOUT_RETAINED_BYTES),
      stderr: new OutputTail(STDERR_RETAINED_BYTES),
      status: 'running',
      settled,
      resolveSettled,
      stopRequested: false,
      observers: 0,
    };
    this.records.set(id, record);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => record.stdout.push(chunk));
    child.stderr?.on('data', (chunk: string) => record.stderr.push(chunk));
    child.once('error', (error) => {
      record.error = error.message;
      this.settle(record, 'failed');
    });
    child.once('exit', (code, signal) => {
      record.exitCode = code ?? undefined;
      record.signal = signal ?? undefined;
    });
    child.once('close', (code, signal) => {
      record.exitCode ??= code ?? undefined;
      record.signal ??= signal ?? undefined;
      const status = record.stopRequested
        ? 'killed'
        : record.exitCode === 0
          ? 'done'
          : 'failed';
      this.settle(record, status);
    });

    this.onChange?.();
    return this.snapshot(record);
  }

  get(id: string): BackgroundSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.snapshot(record) : undefined;
  }

  list(): BackgroundSnapshot[] {
    return [...this.records.values()].map((record) => this.snapshot(record));
  }

  async peek(
    id: string,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<BackgroundSnapshot> {
    const record = this.require(id);
    if (record.status !== 'running' || waitMs <= 0)
      return this.snapshot(record);

    record.observers++;
    try {
      await waitFor(record.settled, waitMs, signal);
      return this.snapshot(record);
    } finally {
      record.observers--;
    }
  }

  async stop(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BackgroundSnapshot[]> {
    const unique = [...new Set(ids)];
    const records = unique.map((id) => this.require(id));
    for (const record of records) record.observers++;

    const stopping = Promise.all(
      records.map((record) => this.terminate(record)),
    );
    try {
      return await (signal ? withAbort(stopping, signal) : stopping);
    } finally {
      for (const record of records) record.observers--;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const running = [...this.records.values()].filter(
      (record) => record.status === 'running',
    );
    await Promise.all(running.map((record) => this.terminate(record)));
    // Only groups still inside their short post-settlement cleanup window are
    // eligible here. Never signal a long-settled PID that may have been reused.
    for (const [record, timer] of this.cleanupTimers) {
      clearTimeout(timer);
      signalTree(record.child, 'SIGKILL', false);
    }
    this.cleanupTimers.clear();
    this.records.clear();
    this.onChange?.();
  }

  get runningCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === 'running') count++;
    }
    return count;
  }

  private require(id: string): ProcessRecord {
    const record = this.records.get(id);
    if (record) return record;
    const known = [...this.records.keys()].join(', ') || 'none';
    throw new Error(`Unknown background process "${id}". Known: ${known}.`);
  }

  private async terminate(record: ProcessRecord): Promise<BackgroundSnapshot> {
    if (record.status !== 'running') return this.snapshot(record);

    record.stopRequested = true;
    signalTree(record.child, 'SIGTERM');
    await waitFor(record.settled, TERM_GRACE_MS);
    if (record.status === 'running') {
      signalTree(record.child, 'SIGKILL');
      await waitFor(record.settled, KILL_GRACE_MS);
    }
    if (record.status === 'running') {
      record.error = 'Process did not report closure after SIGKILL.';
      this.settle(record, 'killed');
    }
    return this.snapshot(record);
  }

  private settle(record: ProcessRecord, status: BackgroundStatus): void {
    if (record.status !== 'running') return;
    record.status = status;
    record.settledAt = Date.now();
    record.resolveSettled();
    this.scheduleTreeCleanup(record);
    const snapshot = this.snapshot(record);
    if (!this.disposed && record.observers === 0) this.onSettled?.(snapshot);
    this.prune();
    this.onChange?.();
  }

  private scheduleTreeCleanup(record: ProcessRecord): void {
    // A shell can exit after backgrounding descendants that close inherited
    // stdio. Keep ownership of its process group even after the leader exits.
    if (!record.stopRequested) signalTree(record.child, 'SIGTERM', false);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(record);
      signalTree(record.child, 'SIGKILL', false);
    }, TERM_GRACE_MS);
    timer.unref();
    this.cleanupTimers.set(record, timer);
  }

  private prune(): void {
    const settled = [...this.records.values()]
      .filter((record) => record.status !== 'running')
      .sort(
        (left, right) =>
          (left.settledAt ?? left.createdAt) -
          (right.settledAt ?? right.createdAt),
      );
    for (const record of settled.slice(0, -MAX_SETTLED)) {
      this.records.delete(record.id);
    }
  }

  private snapshot(record: ProcessRecord): BackgroundSnapshot {
    return {
      id: record.id,
      title: record.title,
      command: record.command,
      cwd: record.cwd,
      pid: record.child.pid,
      status: record.status,
      createdAt: record.createdAt,
      settledAt: record.settledAt,
      exitCode: record.exitCode,
      signal: record.signal,
      error: record.error,
      stdout: record.stdout.snapshot(),
      stderr: record.stderr.snapshot(),
    };
  }
}
