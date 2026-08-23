import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import {
  type BackgroundJobSnapshot,
  BackgroundJobsClient,
} from '@pi-agent/background-jobs';
import { processJsonLine } from './events';
import type { DelegatedRun } from './types';

export const SIGKILL_TIMEOUT_MS = 5000;
/** Reserve a bounded final window for a child to checkpoint before hard stop. */
export const PRETIMEOUT_CHECKPOINT_LEAD_MS = 30_000;
export const MIN_PRETIMEOUT_CHECKPOINT_LEAD_MS = 1_000;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_JSON_LINE_BYTES = 1024 * 1024;
export const PROGRESS_UPDATE_INTERVAL_MS = 1000;

export function appendTail(
  current: string,
  chunk: string,
  maxBytes: number,
): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return combined;
  const prefix = '[Earlier output truncated]\n';
  const tailBudget = Math.max(0, maxBytes - Buffer.byteLength(prefix, 'utf8'));
  let tail = combined.slice(-tailBudget);
  while (Buffer.byteLength(tail, 'utf8') > tailBudget) tail = tail.slice(1);
  return prefix + tail;
}

export interface SpawnChildOptions {
  command: string;
  /** Bounded host display title; never contains the task or launch payload. */
  title?: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** How much of the hard deadline to reserve for a checkpoint request. */
  checkpointLeadMs?: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  /** Parent-manager teardown signal; detaches without stopping a hosted job. */
  detachSignal?: AbortSignal;
  /** Stable UUID used as the process-host job ID for hosted runs. */
  processJobId?: string;
  /** Parent session owner required by the process host. */
  ownerSession?: string;
  onCheckpoint?: () => void;
  onControlAck?: (id: string, kind: string, generation?: number) => void;
  onLine: () => void;
}

export interface SpawnChildResult {
  exitCode: number;
  wasAborted: boolean;
  timedOut: boolean;
  /** A process-spawn/runner failure, distinct from a child nonzero exit. */
  spawnError?: string;
  /** Bounded terminal error reported by the durable process host. */
  hostError?: string;
  /** Parent manager detached and must not receive a terminal settlement. */
  detached?: boolean;
}

/** Resolve the parent home without broadening the child environment allowlist. */
export function effectiveDelegateHome(): string {
  const configured = process.env.HOME;
  if (configured?.trim()) return configured;

  // Node's POSIX homedir() consults HOME, so remove an explicitly empty value
  // while resolving the system fallback and restore it before returning.
  const hadHome = Object.hasOwn(process.env, 'HOME');
  if (hadHome) delete process.env.HOME;
  let fallback: string;
  try {
    fallback = homedir();
  } finally {
    if (hadHome) process.env.HOME = configured;
  }
  if (!fallback.trim() || fallback === '/')
    throw new Error('Could not determine a usable delegate HOME directory.');
  return fallback;
}

export function checkpointLeadMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 0;
  return Math.min(
    PRETIMEOUT_CHECKPOINT_LEAD_MS,
    Math.max(MIN_PRETIMEOUT_CHECKPOINT_LEAD_MS, Math.floor(timeoutMs / 5)),
  );
}

export function buildDelegateChildEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    ...env,
    HOME: effectiveDelegateHome(),
    PI_DELEGATE_CHILD: '1',
  };
}

function isTerminalHostStatus(
  status: BackgroundJobSnapshot['status'],
): boolean {
  return status !== 'running';
}

function isCanonicalUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function hostDiagnostic(run: DelegatedRun, text: string): void {
  run.stderr = appendTail(run.stderr, `\n${text}\n`, MAX_STDERR_BYTES);
}

/**
 * Start a background delegate in the durable process host and replay its event
 * journal. Host output tails are diagnostics only; transcript state comes from
 * complete JSON event records passed through the normal parser.
 */
export async function runHostedDelegateChild(
  run: DelegatedRun,
  options: SpawnChildOptions,
): Promise<SpawnChildResult> {
  if (!options.ownerSession || options.processJobId === undefined)
    throw new Error(
      'Hosted delegates require an owner session and process job ID.',
    );
  if (!isCanonicalUuid(options.processJobId))
    throw new Error(
      'Hosted delegates require a canonical UUID process job ID.',
    );
  const ownerSession = options.ownerSession;
  const processJobId = options.processJobId;
  const client = new BackgroundJobsClient(undefined, ownerSession);
  let detached = options.detachSignal?.aborted === true;
  let cancellationRequested = options.signal?.aborted === true;
  let terminalObserved = false;
  let stopPromise: Promise<void> | undefined;
  let started = false;
  let checkpoint: NodeJS.Timeout | undefined;
  let final: BackgroundJobSnapshot | undefined;
  let reportedHostError: string | undefined;
  let terminalHostError: string | undefined;
  const observeSnapshot = (snapshot: BackgroundJobSnapshot): void => {
    final = snapshot;
    if (
      isTerminalHostStatus(snapshot.status) &&
      snapshot.error &&
      snapshot.error !== reportedHostError
    ) {
      reportedHostError = snapshot.error;
      terminalHostError = appendTail('', snapshot.error, MAX_STDERR_BYTES);
      hostDiagnostic(run, `Process-host terminal error: ${snapshot.error}`);
    }
    if (isTerminalHostStatus(snapshot.status)) terminalObserved = true;
  };
  const stopHost = (force = false): void => {
    if (terminalObserved && !force) return;
    cancellationRequested = true;
    if (!started || stopPromise) return;
    stopPromise = client
      .stop([processJobId])
      .then((jobs) => {
        const stopped = jobs.find((job) => job.id === processJobId);
        if (stopped) observeSnapshot(stopped);
      })
      .catch(() => undefined);
  };
  const abortHandler = () => stopHost();
  const detachHandler = () => {
    detached = true;
  };
  options.signal?.addEventListener('abort', abortHandler, { once: true });
  options.detachSignal?.addEventListener('abort', detachHandler, {
    once: true,
  });
  try {
    const command = await client.start({
      id: processJobId,
      command: options.command,
      title: options.title ?? 'Delegate',
      cwd: options.cwd,
      argv: [options.command, ...options.args],
      env: Object.fromEntries(
        Object.entries(buildDelegateChildEnvironment(options.env)).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      timeoutMs: options.timeoutMs,
      events: true,
      exactEnv: true,
    });
    started = true;
    observeSnapshot(command);
    if (cancellationRequested) stopHost(true);
    const checkpointLead = Math.min(
      Math.max(0, options.checkpointLeadMs ?? 0),
      Math.max(0, options.timeoutMs - 1),
    );
    if (checkpointLead > 0) {
      checkpoint = setTimeout(
        () => {
          if (!detached && !cancellationRequested && !terminalObserved) {
            try {
              options.onCheckpoint?.();
            } catch {
              // Checkpoint delivery is best effort; host timeout remains final.
            }
          }
        },
        Math.max(1, options.timeoutMs - checkpointLead),
      );
      checkpoint.unref();
    }
    let offset = 0;
    let eventsComplete = false;
    while (!detached) {
      const eventBatch = await client.events(processJobId, offset);
      if (eventBatch.truncated) {
        hostDiagnostic(
          run,
          `Process-host event history was truncated before offset ${offset}; missing transcript events were discarded.`,
        );
        eventsComplete = eventBatch.complete;
      }
      // The host journal is offset ordered; sort defensively before replay so
      // a malformed adapter response cannot reorder transcript state.
      for (const event of [...eventBatch.events].sort(
        (left, right) => left.offset - right.offset,
      )) {
        if (event.truncated) {
          hostDiagnostic(
            run,
            `Process-host ${event.stream} event at offset ${event.offset} was truncated and discarded.`,
          );
          continue;
        }
        const line = event.text;
        let parsed: Record<string, unknown> | undefined;
        try {
          const value: unknown = JSON.parse(line);
          if (value && typeof value === 'object' && !Array.isArray(value))
            parsed = value as Record<string, unknown>;
        } catch {
          // Non-JSON stderr is retained as bounded diagnostics below.
        }
        if (
          parsed?.type === 'delegate_control_ack' &&
          typeof parsed.controlId === 'string' &&
          typeof parsed.controlKind === 'string'
        ) {
          options.onControlAck?.(
            parsed.controlId,
            parsed.controlKind,
            typeof parsed.controlGeneration === 'number'
              ? parsed.controlGeneration
              : undefined,
          );
          processJsonLine(line, run);
        } else if (!processJsonLine(line, run) && event.stream === 'stderr') {
          hostDiagnostic(run, line);
        }
        options.onLine();
      }
      offset = Math.max(offset, eventBatch.nextOffset);
      eventsComplete = eventsComplete || eventBatch.complete;
      const inspected = await client.inspect(processJobId);
      if (inspected) observeSnapshot(inspected);
      const current = final ?? command;
      if (isTerminalHostStatus(current.status) && eventsComplete) break;
      if (isTerminalHostStatus(current.status)) {
        // Reconcile one more journal read after terminal state; host stdout and
        // stderr close events can be committed just after the status row.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } else {
        observeSnapshot(await client.wait(processJobId, 100));
      }
    }
    if (detached) {
      // Detach alone leaves the host process running. A cancellation observed
      // before this race still owns a deterministic stop completion.
      if (cancellationRequested && stopPromise) await stopPromise;
      return {
        exitCode: -1,
        wasAborted: false,
        timedOut: false,
        detached: true,
      };
    }
    if (stopPromise) await stopPromise;
    const inspected = await client.inspect(processJobId);
    if (inspected) observeSnapshot(inspected);
    const settled = final ?? command;
    if (settled.timedOut)
      return {
        exitCode: 124,
        wasAborted: false,
        timedOut: true,
        ...(terminalHostError ? { hostError: terminalHostError } : {}),
      };
    if (cancellationRequested)
      return {
        exitCode: 130,
        wasAborted: true,
        timedOut: false,
        ...(terminalHostError ? { hostError: terminalHostError } : {}),
      };
    return {
      exitCode: settled.exitCode ?? (settled.status === 'done' ? 0 : 1),
      wasAborted: false,
      timedOut: false,
      ...(terminalHostError ? { hostError: terminalHostError } : {}),
    };
  } finally {
    if (checkpoint) clearTimeout(checkpoint);
    options.signal?.removeEventListener('abort', abortHandler);
    options.detachSignal?.removeEventListener('abort', detachHandler);
  }
}

/** Spawn a detached Pi child and stream JSON events into the run record. */
export async function spawnDelegateChild(
  run: DelegatedRun,
  options: SpawnChildOptions,
): Promise<SpawnChildResult> {
  let wasAborted = false;
  let timedOut = false;
  let spawnError: string | undefined;

  const exitCode = await new Promise<number>((resolve) => {
    const isWindows = process.platform === 'win32';
    const proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: buildDelegateChildEnvironment(options.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,
    });

    let buffer = '';
    let stderrBuffer = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let discardingLongLine = false;
    let closed = false;
    let settled = false;
    let terminating = false;
    let abortHandler: (() => void) | undefined;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (options.signal && abortHandler)
        options.signal.removeEventListener('abort', abortHandler);
      resolve(code);
    };

    const terminate = (reason: 'abort' | 'timeout' = 'abort') => {
      if (terminating || closed) return;
      terminating = true;
      if (reason === 'timeout') timedOut = true;
      else if (reason === 'abort') wasAborted = true;
      if (isWindows && proc.pid) {
        spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], {
          stdio: 'ignore',
        }).unref();
        return;
      }
      if (proc.pid) {
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {
          proc.kill('SIGTERM');
        }
      }
      setTimeout(() => {
        if (closed || !proc.pid) return;
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          proc.kill('SIGKILL');
        }
      }, options.killGraceMs ?? SIGKILL_TIMEOUT_MS).unref();
    };

    const processControlAck = (
      line: string,
    ): false | 'control' | 'checkpoint' => {
      try {
        const event = JSON.parse(line) as {
          type?: unknown;
          controlId?: unknown;
          controlKind?: unknown;
          controlGeneration?: unknown;
        };
        if (
          event.type !== 'delegate_control_ack' ||
          typeof event.controlId !== 'string' ||
          typeof event.controlKind !== 'string'
        )
          return false;
        // Recognize private records even during termination so they never leak
        // into retained diagnostics, but do not deliver stale callbacks.
        if (terminating) return 'control';
        options.onControlAck?.(
          event.controlId,
          event.controlKind,
          typeof event.controlGeneration === 'number'
            ? event.controlGeneration
            : undefined,
        );
        // Checkpoint acknowledgement also updates the run projection. Pause and
        // resume records intentionally remain private control-plane events.
        if (event.controlKind === 'checkpoint') {
          processJsonLine(line, run);
          return 'checkpoint';
        }
        return 'control';
      } catch {
        return false;
      }
    };

    const processLine = (line: string) => {
      if (terminating) return;
      processControlAck(line);
      if (!processJsonLine(line, run)) return;
      options.onLine();
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += stdoutDecoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (discardingLongLine) {
          discardingLongLine = false;
          continue;
        }
        if (Buffer.byteLength(line, 'utf8') > MAX_JSON_LINE_BYTES) {
          run.stderr = appendTail(
            run.stderr,
            `\nDelegate JSON event exceeded ${MAX_JSON_LINE_BYTES} bytes and was discarded.\n`,
            MAX_STDERR_BYTES,
          );
          continue;
        }
        processLine(line);
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_JSON_LINE_BYTES) {
        buffer = '';
        discardingLongLine = true;
        run.stderr = appendTail(
          run.stderr,
          `\nDelegate JSON event exceeded ${MAX_JSON_LINE_BYTES} bytes and was discarded.\n`,
          MAX_STDERR_BYTES,
        );
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      // Pi JSON mode redirects extension writes to stderr. Control ACKs are
      // private protocol records, not diagnostics, so parse and remove them
      // while retaining every other stderr line as bounded evidence.
      stderrBuffer += stderrDecoder.write(chunk);
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        const control = processControlAck(line);
        if (control === 'checkpoint') {
          options.onLine();
        } else if (!control)
          run.stderr = appendTail(run.stderr, `${line}\n`, MAX_STDERR_BYTES);
      }
      if (Buffer.byteLength(stderrBuffer, 'utf8') > MAX_STDERR_BYTES) {
        run.stderr = appendTail(run.stderr, stderrBuffer, MAX_STDERR_BYTES);
        stderrBuffer = '';
      }
    });
    proc.on('close', (code) => {
      closed = true;
      buffer += stdoutDecoder.end();
      if (buffer.trim() && !discardingLongLine) processLine(buffer);
      stderrBuffer += stderrDecoder.end();
      if (stderrBuffer) {
        const control = processControlAck(stderrBuffer);
        if (control === 'checkpoint') {
          options.onLine();
        } else if (!control)
          run.stderr = appendTail(run.stderr, stderrBuffer, MAX_STDERR_BYTES);
      }
      finish(code ?? 1);
    });
    proc.on('error', (error) => {
      spawnError = error.message;
      run.stderr = appendTail(run.stderr, error.message, MAX_STDERR_BYTES);
      finish(1);
    });

    const checkpointLead = Math.min(
      Math.max(0, options.checkpointLeadMs ?? 0),
      Math.max(0, options.timeoutMs - 1),
    );
    const checkpoint =
      checkpointLead > 0
        ? setTimeout(
            () => {
              if (closed || terminating) return;
              try {
                options.onCheckpoint?.();
              } catch {
                // Checkpoint delivery is best effort; the hard timeout remains
                // authoritative even if the control path fails.
              }
            },
            Math.max(1, options.timeoutMs - checkpointLead),
          )
        : undefined;
    checkpoint?.unref();
    const timeout = setTimeout(() => terminate('timeout'), options.timeoutMs);
    timeout.unref();
    proc.once('close', () => {
      clearTimeout(timeout);
      if (checkpoint) clearTimeout(checkpoint);
    });

    abortHandler = () => terminate('abort');
    if (options.signal?.aborted) abortHandler();
    else
      options.signal?.addEventListener('abort', abortHandler, { once: true });
  });

  return {
    exitCode: wasAborted ? 130 : timedOut ? 124 : exitCode,
    wasAborted,
    timedOut,
    ...(spawnError ? { spawnError } : {}),
  };
}
