import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { waitFor } from '../shared/runtime/async';
import { AsyncJobRegistry, type JobRecord } from '../shared/runtime/registry';
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

interface ProcessRecord extends JobRecord<BackgroundStatus> {
  readonly title: string;
  readonly command: string;
  readonly cwd: string;
  readonly child: ChildProcess;
  readonly stdout: OutputTail;
  readonly stderr: OutputTail;
  exitCode?: number;
  signal?: string;
  error?: string;
  stopRequested: boolean;
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
  private readonly registry: AsyncJobRegistry<
    BackgroundStatus,
    ProcessRecord,
    BackgroundSnapshot
  >;
  private readonly cleanupTimers = new Map<ProcessRecord, NodeJS.Timeout>();

  constructor(options: BackgroundManagerOptions = {}) {
    this.registry = new AsyncJobRegistry({
      idPrefix: 'bg',
      label: 'background process',
      maxActive: MAX_RUNNING,
      maxSettled: MAX_SETTLED,
      isActive: (status) => status === 'running',
      snapshot: (record) => snapshot(record),
      capacityError: `At most ${MAX_RUNNING} background processes may run at once.`,
      disposedError: 'Background manager is shutting down.',
      teardown: (record) => this.terminate(record),
      onSettled: options.onSettled,
      onChange: options.onChange,
    });
  }

  start(options: StartOptions): BackgroundSnapshot {
    this.registry.assertAccepting();

    const [shell, args] = shellInvocation(options.command);
    const child = spawn(shell, args, {
      cwd: options.cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const record: ProcessRecord = {
      ...this.registry.newRecord('running'),
      title: options.title,
      command: displayCommand(options.command),
      cwd: resolve(options.cwd),
      child,
      stdout: new OutputTail(STDOUT_RETAINED_BYTES),
      stderr: new OutputTail(STDERR_RETAINED_BYTES),
      stopRequested: false,
    };
    this.registry.add(record);

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
      this.settle(
        record,
        record.stopRequested
          ? 'killed'
          : record.exitCode === 0
            ? 'done'
            : 'failed',
      );
    });

    this.registry.changed();
    return snapshot(record);
  }

  get(id: string): BackgroundSnapshot | undefined {
    return this.registry.get(id);
  }

  list(): BackgroundSnapshot[] {
    return this.registry.list();
  }

  peek(
    id: string,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<BackgroundSnapshot> {
    return this.registry.peek(id, waitMs, signal);
  }

  async stop(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BackgroundSnapshot[]> {
    const records = [...new Set(ids)].map((id) => this.registry.require(id));
    return this.registry.observing(
      records,
      () => Promise.all(records.map((record) => this.terminate(record))),
      signal,
    );
  }

  async dispose(): Promise<void> {
    if (this.registry.disposed) return;
    await this.registry.dispose();
    // Only groups still inside their short post-settlement cleanup window are
    // eligible here. Never signal a long-settled PID that may have been reused.
    for (const [record, timer] of this.cleanupTimers) {
      clearTimeout(timer);
      signalTree(record.child, 'SIGKILL', false);
    }
    this.cleanupTimers.clear();
  }

  get runningCount(): number {
    return this.registry.activeCount;
  }

  private async terminate(record: ProcessRecord): Promise<BackgroundSnapshot> {
    if (record.state !== 'running') return snapshot(record);

    record.stopRequested = true;
    signalTree(record.child, 'SIGTERM');
    await waitFor(record.settled, TERM_GRACE_MS);
    if (record.state === 'running') {
      signalTree(record.child, 'SIGKILL');
      await waitFor(record.settled, KILL_GRACE_MS);
    }
    if (record.state === 'running') {
      record.error = 'Process did not report closure after SIGKILL.';
      this.settle(record, 'killed');
    }
    return snapshot(record);
  }

  private settle(record: ProcessRecord, status: BackgroundStatus): void {
    if (record.state !== 'running') return;
    this.scheduleTreeCleanup(record);
    this.registry.settle(record, status);
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
}

function snapshot(record: ProcessRecord): BackgroundSnapshot {
  return {
    id: record.id,
    title: record.title,
    command: record.command,
    cwd: record.cwd,
    pid: record.child.pid,
    status: record.state,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
    exitCode: record.exitCode,
    signal: record.signal,
    error: record.error,
    stdout: record.stdout.snapshot(),
    stderr: record.stderr.snapshot(),
  };
}
