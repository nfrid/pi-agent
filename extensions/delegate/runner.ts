import * as path from 'node:path';
import { acquireSession, acquireSlot } from './concurrency';
import {
  PROGRESS_UPDATE_INTERVAL_MS,
  spawnDelegateChild,
} from './delegate-child';
import { buildDelegatePrompt } from './prompt';
import { makeDetails } from './tool-result';
import {
  createRun,
  type DelegateContext,
  type DelegateDetails,
  type DelegatedRun,
  type DelegateIsolation,
  type DelegateRouteState,
  getFinalAssistantText,
  isRunError,
} from './types';
import { type PreparedWorktree, worktreeSummary } from './worktree';

// Read-only is an intent signal, not an enforced boundary: the child still has
// bash, so it can inspect the repository the same way any agent would.
const READ_ONLY_TOOLS = 'read,bash,grep,find,ls';
const WRITE_TOOLS = 'read,edit,write,bash,grep,find,ls';
const DELEGATE_EXTENSION = path.resolve(__dirname, 'index.ts');
const SYSTEM_PROMPT_EXTENSION = path.resolve(
  __dirname,
  '../system-prompt/index.ts',
);

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
        return `${icon} ${activity.label}`;
      })
      .join('\n');
  }
  return '(running...)';
}

export interface RunDelegateOptions {
  cwd: string;
  name?: string;
  task: string;
  context: DelegateContext;
  sessionPath: string;
  routing?: DelegateRouteState;
  allowWrites?: boolean;
  writeRequested?: boolean;
  isolation: DelegateIsolation;
  worktree?: PreparedWorktree;
  contextNote?: string;
  scope?: string[];
  continuation?: string;
  resuming?: boolean;
  timeoutMs: number;
  maxConcurrency: number;
  killGraceMs?: number;
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
    | 'worktree'
    | 'contextNote'
    | 'scope'
    | 'resuming'
  > & { timeoutMs?: number },
  sessionPath: string,
): string[] {
  const allowWrites = options.allowWrites === true;
  if (allowWrites && !options.worktree)
    throw new Error('Writable delegates require a prepared worktree.');
  const args = [
    '--mode',
    'json',
    '-p',
    '--no-extensions',
    '--extension',
    DELEGATE_EXTENSION,
    '--extension',
    SYSTEM_PROMPT_EXTENSION,
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--tools',
    allowWrites ? WRITE_TOOLS : READ_ONLY_TOOLS,
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
      timeoutMs: options.timeoutMs,
      branch: options.worktree?.record.branch,
    }),
  );
  return args;
}

export async function runDelegate(
  options: RunDelegateOptions,
): Promise<DelegatedRun> {
  const writeRequested = options.writeRequested ?? options.allowWrites ?? false;
  const allowWrites = options.allowWrites === true;
  const run = createRun(options.task, options.routing, {
    name: options.name,
    cwd: options.cwd,
    context: options.context,
    allowWrites,
    writeRequested,
    isolation: options.isolation,
    worktree: options.worktree
      ? worktreeSummary(options.worktree.record)
      : undefined,
    contextNote: options.contextNote,
    scope: options.scope,
    continuation: options.continuation,
  });
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
    releaseSession = await acquireSession(options.sessionPath, options.signal);
    if (options.signal?.aborted)
      throw new Error('Delegated task was aborted before launch.');
    releaseSlot = await acquireSlot(options.signal, options.maxConcurrency);
    if (options.signal?.aborted)
      throw new Error('Delegated task was aborted before launch.');
    run.state = 'running';
    run.startedAt = Date.now();
    emitUpdate();
    const { command, prefixArgs } = resolvePiSpawn();
    const args = buildChildArgs(options, options.sessionPath);
    const spawnTarget = {
      command,
      args: [...prefixArgs, ...args],
      cwd: options.cwd,
      env: options.worktree?.env ?? {},
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
  }
  return run;
}
