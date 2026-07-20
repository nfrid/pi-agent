import * as path from 'node:path';
import { acquireSession, acquireSlot } from './concurrency';
import {
  PROGRESS_UPDATE_INTERVAL_MS,
  spawnDelegateChild,
} from './delegate-child';
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
import { makeDetails } from './tool-result';
import {
  createRun,
  type DelegateContext,
  type DelegateDetails,
  type DelegatedRun,
  type DelegateRouteState,
  getFinalAssistantText,
  isRunError,
} from './types';

const CONTROLLED_READ_ONLY_TOOLS = 'read,grep,find,ls';
const SANDBOXED_READ_ONLY_TOOLS = 'read,inspect_shell,grep,find,ls';
const WRITE_TOOLS = 'read,edit,write,grep,find,ls';
const DELEGATE_EXTENSION = path.resolve(__dirname, 'index.ts');
const SYSTEM_PROMPT_EXTENSION = path.resolve(
  __dirname,
  '../system-prompt/index.ts',
);
const INSPECT_SHELL_EXTENSION = path.resolve(__dirname, 'inspect-shell.ts');

export { mapWithConcurrency } from './concurrency';

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
  mode: DelegateDetails['mode'];
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
    DELEGATE_EXTENSION,
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
      inspectShell: !allowWrites && Boolean(options.readOnlyBash),
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
      details: makeDetails(options.mode, [run]),
    });
    return run;
  }
  let releaseSlot: (() => void) | undefined;
  let releaseSession: (() => void) | undefined;

  const emitUpdate = () => {
    options.onUpdate?.({
      content: [{ type: 'text', text: progressText(run) }],
      details: makeDetails(options.mode, [run]),
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

    const { exitCode, wasAborted, timedOut } = await spawnDelegateChild(run, {
      command: spawnTarget.command,
      args: spawnTarget.args,
      cwd: spawnTarget.cwd,
      env: spawnTarget.env,
      timeoutMs: options.timeoutMs,
      killGraceMs: options.killGraceMs,
      signal: options.signal,
      onLine: emitUpdate,
    });

    run.exitCode = exitCode;
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
