import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
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
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** How much of the hard deadline to reserve for a checkpoint request. */
  checkpointLeadMs?: number;
  killGraceMs?: number;
  signal?: AbortSignal;
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
    ): false | 'control' | 'checkpoint' | 'structured-repair' => {
      try {
        const event = JSON.parse(line) as {
          type?: unknown;
          controlId?: unknown;
          controlKind?: unknown;
          controlGeneration?: unknown;
        };
        if (event.type === 'delegate_structured_repair')
          return 'structured-repair';
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
      const privateEvent = processControlAck(line);
      if (privateEvent === 'structured-repair') {
        processJsonLine(line, run);
        options.onLine();
        return;
      }
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
        if (control === 'checkpoint' || control === 'structured-repair') {
          if (control === 'structured-repair') processJsonLine(line, run);
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
        if (control === 'checkpoint' || control === 'structured-repair') {
          if (control === 'structured-repair')
            processJsonLine(stderrBuffer, run);
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
