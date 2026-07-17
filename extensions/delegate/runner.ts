import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { processJsonLine } from './events';
import {
  discardChildAuth,
  discardReadOnlySandbox,
  isolationSpawn,
  type PreparedIsolation,
  prepareChildAuth,
  prepareReadOnlySandbox,
  readOnlySandboxSpawn,
  scrubIsolationCredentials,
} from './isolation';
import { buildDelegatePrompt } from './prompt';
import {
  createRun,
  type DelegateContext,
  type DelegateDetails,
  type DelegatedRun,
  type DelegateRouteState,
  getFinalAssistantText,
  isRunError,
} from './types';

const SIGKILL_TIMEOUT_MS = 5000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_JSON_LINE_BYTES = 1024 * 1024;
const CONTROLLED_READ_ONLY_TOOLS = 'read,grep,find,ls';
const SANDBOXED_READ_ONLY_TOOLS = 'read,inspect_shell,grep,find,ls';
const WRITE_TOOLS = 'read,edit,write,grep,find,ls';
const MAX_GLOBAL_CONCURRENCY = 3;
const PROGRESS_UPDATE_INTERVAL_MS = 1000;
const SYSTEM_PROMPT_EXTENSION = path.resolve(
  __dirname,
  '../system-prompt/index.ts',
);
const INSPECT_SHELL_EXTENSION = path.resolve(__dirname, 'inspect-shell.ts');

let activeRuns = 0;
const slotWaiters: Array<() => void> = [];
const sessionTails = new Map<string, Promise<void>>();

async function acquireSession(sessionPath: string): Promise<() => void> {
  const previous = sessionTails.get(sessionPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionTails.set(sessionPath, current);
  await previous;
  return () => {
    release();
    if (sessionTails.get(sessionPath) === current)
      sessionTails.delete(sessionPath);
  };
}

async function acquireSlot(
  signal?: AbortSignal,
  maxConcurrency = MAX_GLOBAL_CONCURRENCY,
): Promise<() => void> {
  if (signal?.aborted)
    throw new Error('Delegated task was aborted before launch.');
  if (activeRuns < maxConcurrency) activeRuns++;
  else {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = slotWaiters.indexOf(onReady);
        if (index >= 0) slotWaiters.splice(index, 1);
        reject(new Error('Delegated task was aborted before launch.'));
      };
      const onReady = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      slotWaiters.push(onReady);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = slotWaiters.shift();
    if (next) next();
    else activeRuns--;
  };
}

type OnUpdate = (partial: {
  content: Array<{ type: 'text'; text: string }>;
  details: DelegateDetails;
}) => void;

export function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  // Resolve Pi from PATH rather than reusing the parent process's entry script.
  // A long-running parent may point at an older installation after Pi is upgraded,
  // causing delegates to use stale provider/model routing code.
  return { command: 'pi', prefixArgs: [] };
}

function appendTail(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return combined;
  const prefix = '[Earlier output truncated]\n';
  const tailBudget = Math.max(0, maxBytes - Buffer.byteLength(prefix, 'utf8'));
  let tail = combined.slice(-tailBudget);
  while (Buffer.byteLength(tail, 'utf8') > tailBudget) tail = tail.slice(1);
  return prefix + tail;
}

function progressText(run: DelegatedRun): string {
  const final = getFinalAssistantText(run.messages).trim();
  if (final) return final;
  if (run.errorMessage?.trim()) return run.errorMessage.trim();
  const recent = run.activities.slice(-8);
  if (recent.length > 0) {
    return recent
      .map((activity) => {
        const icon =
          activity.status === 'running'
            ? '…'
            : activity.status === 'error'
              ? '×'
              : '✓';
        return `${icon} ${activity.label}${activity.latestText ? `\n${activity.latestText}` : ''}`;
      })
      .join('\n');
  }
  return '(running...)';
}

export interface RunDelegateOptions {
  cwd: string;
  task: string;
  context: DelegateContext;
  sessionPath: string;
  routing?: DelegateRouteState;
  allowWrites?: boolean;
  writeRequested?: boolean;
  isolation?: PreparedIsolation;
  contextNote?: string;
  scope?: string[];
  continuation?: string;
  resuming?: boolean;
  timeoutMs: number;
  maxConcurrency: number;
  killGraceMs?: number;
  readOnlyBash?: boolean;
  signal?: AbortSignal;
  onUpdate?: OnUpdate;
  makeDetails: (runs: DelegatedRun[]) => DelegateDetails;
}

export function buildChildArgs(
  options: Pick<
    RunDelegateOptions,
    | 'task'
    | 'routing'
    | 'allowWrites'
    | 'isolation'
    | 'readOnlyBash'
    | 'contextNote'
    | 'scope'
    | 'resuming'
  >,
  sessionPath: string,
): string[] {
  const allowWrites =
    options.allowWrites === true && Boolean(options.isolation);
  const args = [
    '--mode',
    'json',
    '-p',
    '--no-extensions',
    '--extension',
    SYSTEM_PROMPT_EXTENSION,
    ...(options.readOnlyBash ? ['--extension', INSPECT_SHELL_EXTENSION] : []),
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--tools',
    allowWrites
      ? WRITE_TOOLS
      : options.readOnlyBash
        ? SANDBOXED_READ_ONLY_TOOLS
        : CONTROLLED_READ_ONLY_TOOLS,
  ];
  args.push('--session', sessionPath);
  if (options.routing) {
    args.push('--provider', options.routing.provider);
    args.push('--model', options.routing.model);
    args.push('--thinking', options.routing.thinking);
  }
  args.push(
    buildDelegatePrompt(options.task, {
      allowWrites,
      contextNote: options.contextNote,
      scope: options.scope,
      continuation: options.resuming,
    }),
  );
  return args;
}

export async function runDelegate(
  options: RunDelegateOptions,
): Promise<DelegatedRun> {
  const writeRequested = options.writeRequested ?? options.allowWrites ?? false;
  const allowWrites =
    options.allowWrites === true && Boolean(options.isolation);
  const readOnlySandbox =
    options.allowWrites !== true && !options.isolation
      ? prepareReadOnlySandbox(options.cwd, options.sessionPath)
      : undefined;
  const childAuth =
    !options.isolation && !readOnlySandbox && options.allowWrites !== true
      ? prepareChildAuth()
      : undefined;
  const run = createRun(options.task, options.routing, {
    cwd: options.cwd,
    context: options.context,
    allowWrites,
    writeRequested,
    readOnlyBoundary: allowWrites
      ? undefined
      : readOnlySandbox
        ? 'macos-sandbox-exec'
        : options.isolation
          ? 'isolated-controlled-tools'
          : 'controlled-tools',
    isolation: options.isolation
      ? {
          id: options.isolation.record.id,
          backend: options.isolation.record.backend,
          repositoryRoot: options.isolation.record.repositoryRoot,
          worktreePath: options.isolation.record.worktreePath,
          workingDirectory: options.isolation.record.workingDirectory,
          baseHead: options.isolation.record.baseHead,
          dependencyMode: options.isolation.record.dependencyMode,
          status: options.isolation.record.status,
        }
      : undefined,
    contextNote: options.contextNote,
    scope: options.scope,
    continuation: options.continuation,
  });
  if (
    !allowWrites &&
    !options.isolation &&
    !readOnlySandbox &&
    options.allowWrites !== true
  )
    run.warnings = [
      ...(run.warnings ?? []),
      'Read-only shell sandbox is unavailable; Bash was removed and only controlled inspection tools are enabled.',
    ];
  if (options.allowWrites === true && !options.isolation) {
    run.exitCode = 1;
    run.state = 'error';
    run.stopReason = 'error';
    run.errorMessage =
      'Writable delegate execution requires a prepared isolation proof; child launch was blocked.';
    run.finishedAt = Date.now();
    options.onUpdate?.({
      content: [{ type: 'text', text: run.errorMessage }],
      details: options.makeDetails([run]),
    });
    return run;
  }
  let releaseSlot: (() => void) | undefined;
  let releaseSession: (() => void) | undefined;
  let wasAborted = false;
  let timedOut = false;

  const emitUpdate = () => {
    options.onUpdate?.({
      content: [{ type: 'text', text: progressText(run) }],
      details: options.makeDetails([run]),
    });
  };

  emitUpdate();
  const updateTimer = options.onUpdate
    ? setInterval(emitUpdate, PROGRESS_UPDATE_INTERVAL_MS)
    : undefined;
  updateTimer?.unref();
  try {
    releaseSession = await acquireSession(options.sessionPath);
    if (options.signal?.aborted)
      throw new Error('Delegated task was aborted before launch.');
    releaseSlot = await acquireSlot(options.signal, options.maxConcurrency);
    if (options.signal?.aborted)
      throw new Error('Delegated task was aborted before launch.');
    run.state = 'running';
    run.startedAt = Date.now();
    emitUpdate();
    const { command, prefixArgs } = resolvePiSpawn();
    const args = buildChildArgs(
      { ...options, readOnlyBash: Boolean(readOnlySandbox) },
      options.sessionPath,
    );
    const spawnTarget = options.isolation
      ? isolationSpawn(options.isolation, command, [...prefixArgs, ...args])
      : readOnlySandbox
        ? readOnlySandboxSpawn(readOnlySandbox, command, [
            ...prefixArgs,
            ...args,
          ])
        : {
            command,
            args: [...prefixArgs, ...args],
            cwd: options.cwd,
            env: childAuth?.env ?? {},
          };

    const exitCode = await new Promise<number>((resolve) => {
      const isWindows = process.platform === 'win32';
      const proc = spawn(spawnTarget.command, spawnTarget.args, {
        cwd: spawnTarget.cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'C',
          LC_ALL: 'C',
          ...spawnTarget.env,
          PI_DELEGATE_CHILD: '1',
        },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A detached Unix child is its own process group, allowing us to stop
        // tools it launched as well as Pi itself.
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
        emitUpdate();
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

    run.exitCode = wasAborted ? 130 : timedOut ? 124 : exitCode;
    if (wasAborted) {
      run.stopReason = 'aborted';
      run.errorMessage = 'Delegated task was aborted.';
      run.state = 'aborted';
    } else if (timedOut) {
      run.stopReason = 'error';
      run.errorMessage = `Delegated task timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`;
      run.state = 'timed-out';
    } else if (exitCode !== 0 && !run.errorMessage) {
      run.stopReason = 'error';
      run.errorMessage =
        run.stderr.trim() || `Child Pi exited with code ${exitCode}.`;
    }
    if (run.state === 'running')
      run.state = isRunError(run) ? 'error' : 'success';
  } catch (error) {
    const aborted = options.signal?.aborted ?? false;
    run.exitCode = aborted ? 130 : 1;
    run.stopReason = aborted ? 'aborted' : 'error';
    run.errorMessage = aborted
      ? 'Delegated task was aborted.'
      : error instanceof Error
        ? error.message
        : String(error);
    run.state = aborted ? 'aborted' : 'error';
  } finally {
    if (updateTimer) clearInterval(updateTimer);
    run.finishedAt = Date.now();
    emitUpdate();
    releaseSlot?.();
    releaseSession?.();
    scrubIsolationCredentials(options.isolation);
    discardReadOnlySandbox(readOnlySandbox);
    discardChildAuth(childAuth);
  }
  return run;
}

export async function mapWithConcurrency<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(concurrency, items.length)))
    .fill(null)
    .map(async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    });
  await Promise.all(workers);
  return results;
}
