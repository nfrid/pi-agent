import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import {
  BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES,
  type BackgroundJobSnapshot,
  BackgroundJobsClient,
} from '@pi-agent/background-jobs';
import { processJsonLine } from './events';
import { recordDelegateEventOverflow } from './lifecycle';
import type { DelegatedRun } from './types';
import { isCanonicalUuid } from './workflow-model';

export const SIGKILL_TIMEOUT_MS = 5000;
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
  killGraceMs?: number;
  signal?: AbortSignal;
  /** Parent-manager teardown signal; detaches without stopping a hosted job. */
  detachSignal?: AbortSignal;
  /** Stable UUID used as the process-host job ID for hosted runs. */
  processJobId?: string;
  /** Reattach to an existing owner-scoped host job; never send start. */
  observeExisting?: boolean;
  /** Parent session owner required by the process host. */
  ownerSession?: string;
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
  /** A socket/transport failure that can be retried without relaunching. */
  retryable?: boolean;
  /** Parent manager detached and must not receive a terminal settlement. */
  detached?: boolean;
}

/** Classify transport failures without treating unknown jobs or host terminals as retryable. */
export function isTransientHostSocketError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message =
    typeof candidate.message === 'string' ? candidate.message : String(error);
  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENOENT',
    ].includes(code)
  )
    return true;
  return /(?:fetch failed|socket|connection reset|connection refused|transport.*(?:closed|failed|unavailable)|timed out|timeout|(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOENT))/iu.test(
    message,
  );
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
    const capabilities = await client.info();
    if (capabilities.exactEnv !== true)
      throw new Error(
        'Hosted delegates require a process host with exactEnv support.',
      );
    let command: BackgroundJobSnapshot;
    if (options.observeExisting) {
      const inspected = await client.inspect(processJobId);
      if (!inspected)
        throw new Error(`Unknown hosted process job "${processJobId}".`);
      // The known row is the only launch fact trusted during reattachment.
      // Never reconstruct or resend the original command/argv/env.
      command = inspected;
      started = true;
      observeSnapshot(command);
    } else {
      command = await client.start({
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
        events: true,
        exactEnv: true,
      });
      started = true;
      observeSnapshot(command);
    }
    if (cancellationRequested) stopHost(true);
    let offset = 0;
    let eventsComplete = false;
    while (!detached) {
      const eventBatch = await client.events(processJobId, offset);
      if (eventBatch.truncated) {
        recordDelegateEventOverflow(run, 0, undefined, 'legacy-host');
        hostDiagnostic(
          run,
          `Process-host event history was truncated before offset ${offset}; missing transcript events could not be recovered.`,
        );
        eventsComplete = eventBatch.complete;
      }
      // The host journal is offset ordered; sort defensively before replay so
      // a malformed adapter response cannot reorder transcript state.
      for (const event of [...eventBatch.events].sort(
        (left, right) => left.offset - right.offset,
      )) {
        if (event.truncated) {
          if (event.stream === 'stderr') {
            hostDiagnostic(
              run,
              `Process-host stderr event at offset ${event.offset} was truncated and excluded from diagnostics.`,
            );
            continue;
          }
          let content: Buffer | undefined;
          let unavailableReason:
            | 'capture-limit'
            | 'host-publication-failed'
            | 'legacy-host'
            | 'artifact-read-failed' = 'legacy-host';
          if (event.overflow) {
            unavailableReason =
              event.overflow.unavailableReason === 'publication-failed'
                ? 'host-publication-failed'
                : 'capture-limit';
            const file = event.overflow.artifactPath;
            if (
              file &&
              event.overflow.bytes <= BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES
            ) {
              try {
                const size = statSync(file).size;
                if (size === event.overflow.bytes) {
                  content = readFileSync(file);
                  if (content.byteLength !== size) content = undefined;
                }
                if (content) unavailableReason = 'capture-limit';
                else if (!event.overflow.unavailableReason)
                  unavailableReason = 'artifact-read-failed';
              } catch {
                unavailableReason = 'artifact-read-failed';
              }
            }
          }
          recordDelegateEventOverflow(
            run,
            event.overflow?.bytes ?? 0,
            content,
            content ? undefined : unavailableReason,
          );
          hostDiagnostic(
            run,
            `Process-host ${event.stream} event at offset ${event.offset} was truncated and excluded from transcript parsing.`,
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
    const detachedResult = (): SpawnChildResult => ({
      exitCode: -1,
      wasAborted: false,
      timedOut: false,
      detached: true,
    });
    if (stopPromise) await stopPromise;
    if (detached) return detachedResult();
    const inspected = await client.inspect(processJobId);
    if (inspected) observeSnapshot(inspected);
    if (detached) return detachedResult();
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
  } catch (error) {
    if (!isTransientHostSocketError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const hostError = appendTail('', message, MAX_STDERR_BYTES);
    hostDiagnostic(run, `Retryable process-host transport error: ${hostError}`);
    return {
      exitCode: 1,
      wasAborted: false,
      timedOut: false,
      hostError,
      retryable: true,
    };
  } finally {
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

    let stderrBuffer = '';
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutLineChunks: Buffer[] = [];
    let stdoutLineBytes = 0;
    let stdoutLineEndsWithCr = false;
    let stdoutLineCaptureFailed = false;
    let capturedOverflowBytes = 0;
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

    const terminate = () => {
      if (terminating || closed) return;
      terminating = true;
      wasAborted = true;
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

    const processStdoutLine = (rawLine: Buffer) => {
      const line =
        rawLine.at(-1) === 0x0d
          ? rawLine.subarray(0, rawLine.byteLength - 1)
          : rawLine;
      const lineBytes = stdoutLineBytes - (stdoutLineEndsWithCr ? 1 : 0);
      if (lineBytes > MAX_JSON_LINE_BYTES) {
        let content = stdoutLineCaptureFailed
          ? undefined
          : Buffer.concat(stdoutLineChunks);
        if (content?.at(-1) === 0x0d)
          content = content.subarray(0, content.byteLength - 1);
        if (
          content?.byteLength === lineBytes &&
          capturedOverflowBytes + content.byteLength <=
            BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES
        ) {
          capturedOverflowBytes += content.byteLength;
        } else content = undefined;
        recordDelegateEventOverflow(
          run,
          lineBytes,
          content,
          content ? undefined : 'capture-limit',
        );
        run.stderr = appendTail(
          run.stderr,
          `\nDelegate JSON event exceeded ${MAX_JSON_LINE_BYTES} bytes and was excluded from transcript parsing.\n`,
          MAX_STDERR_BYTES,
        );
      } else {
        processLine(line.toString('utf8'));
      }
      stdoutLineChunks = [];
      stdoutLineBytes = 0;
      stdoutLineEndsWithCr = false;
      stdoutLineCaptureFailed = false;
    };
    const appendStdoutPart = (part: Buffer) => {
      stdoutLineBytes += part.byteLength;
      if (part.byteLength > 0) stdoutLineEndsWithCr = part.at(-1) === 0x0d;
      if (!stdoutLineCaptureFailed) {
        if (
          stdoutLineBytes <= MAX_JSON_LINE_BYTES ||
          capturedOverflowBytes + stdoutLineBytes <=
            BACKGROUND_JOBS_MAX_EVENT_ARTIFACT_BYTES
        ) {
          stdoutLineChunks.push(Buffer.from(part));
        } else {
          stdoutLineCaptureFailed = true;
          stdoutLineChunks = [];
        }
      }
    };
    proc.stdout.on('data', (chunk: Buffer) => {
      let start = 0;
      let newline = chunk.indexOf(0x0a, start);
      while (newline >= 0) {
        appendStdoutPart(chunk.subarray(start, newline));
        processStdoutLine(Buffer.concat(stdoutLineChunks));
        start = newline + 1;
        newline = chunk.indexOf(0x0a, start);
      }
      if (start < chunk.byteLength) appendStdoutPart(chunk.subarray(start));
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
      if (stdoutLineBytes > 0) {
        const remaining = stdoutLineCaptureFailed
          ? Buffer.alloc(0)
          : Buffer.concat(stdoutLineChunks);
        if (
          remaining.toString('utf8').trim() ||
          stdoutLineCaptureFailed ||
          stdoutLineBytes > MAX_JSON_LINE_BYTES
        )
          processStdoutLine(remaining);
      }
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

    abortHandler = terminate;
    if (options.signal?.aborted) abortHandler();
    else
      options.signal?.addEventListener('abort', abortHandler, { once: true });
  });

  return {
    exitCode: wasAborted ? 130 : exitCode,
    wasAborted,
    timedOut: false,
    ...(spawnError ? { spawnError } : {}),
  };
}
