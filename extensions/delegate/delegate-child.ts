import { spawn } from 'node:child_process';
import { processJsonLine } from './events';
import type { DelegatedRun } from './types';

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
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  onLine: () => void;
}

export interface SpawnChildResult {
  exitCode: number;
  wasAborted: boolean;
  timedOut: boolean;
}

/** Spawn a detached Pi child and stream JSON events into the run record. */
export async function spawnDelegateChild(
  run: DelegatedRun,
  options: SpawnChildOptions,
): Promise<SpawnChildResult> {
  let wasAborted = false;
  let timedOut = false;

  const exitCode = await new Promise<number>((resolve) => {
    const isWindows = process.platform === 'win32';
    const proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'C',
        LC_ALL: 'C',
        ...options.env,
        PI_DELEGATE_CHILD: '1',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,
    });

    let buffer = '';
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

    const processLine = (line: string) => {
      if (terminating || !processJsonLine(line, run)) return;
      options.onLine();
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
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
      run.stderr = appendTail(run.stderr, chunk.toString(), MAX_STDERR_BYTES);
    });
    proc.on('close', (code) => {
      closed = true;
      if (buffer.trim() && !discardingLongLine) processLine(buffer);
      finish(code ?? 1);
    });
    proc.on('error', (error) => {
      run.stderr = appendTail(run.stderr, error.message, MAX_STDERR_BYTES);
      finish(1);
    });

    const timeout = setTimeout(() => terminate('timeout'), options.timeoutMs);
    timeout.unref();
    proc.once('close', () => clearTimeout(timeout));

    abortHandler = () => terminate('abort');
    if (options.signal?.aborted) abortHandler();
    else
      options.signal?.addEventListener('abort', abortHandler, { once: true });
  });

  return {
    exitCode: wasAborted ? 130 : timedOut ? 124 : exitCode,
    wasAborted,
    timedOut,
  };
}
