import * as path from 'node:path';
import { acquireSession, acquireSlot } from './concurrency';
import {
  checkpointRequestMessage,
  createDelegateControlChannel,
  type DelegateControlChannel,
} from './control';
import {
  checkpointLeadMs,
  PROGRESS_UPDATE_INTERVAL_MS,
  spawnDelegateChild,
} from './delegate-child';
import {
  buildLifecycleDiagnostic,
  getDelegateLifecycle,
  setDelegateLifecycle,
  setDelegateLifecycleText,
} from './lifecycle';
import { buildDelegatePrompt } from './prompt';
import {
  getDelegateChannelPresent,
  getDelegateResultSpec,
  type NormalizedDelegateResultSpec,
  setDelegateResultSpec,
} from './structured-result';
import { makeDetails } from './tool-result';
import {
  createRun,
  type DelegateContext,
  type DelegateDetails,
  type DelegatedRun,
  type DelegateIsolation,
  type DelegateRouteState,
  getFinalAssistantText,
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
const MID_RUN_COMPACTION_EXTENSION = path.resolve(
  __dirname,
  '../mid-run-compaction/index.ts',
);
const TOOL_ARGUMENT_VALIDATION_EXTENSION = path.resolve(
  __dirname,
  '../tool-argument-validation/index.ts',
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
  // Structured results are artifact-only. Assistant prose can arrive before
  // the terminating delegate_result event, so never use it for live progress.
  const structured = Boolean(getDelegateResultSpec(run));
  const final = structured ? '' : getFinalAssistantText(run.messages).trim();
  if (final) return final;
  if (!structured && run.errorMessage?.trim()) return run.errorMessage.trim();
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
  /** Resolved upstream evidence, never included in parent-visible run details. */
  handoffText?: string;
  /** Bounded structured result contract, kept outside parent-visible details. */
  resultSpec?: NormalizedDelegateResultSpec;
  scope?: string[];
  continuation?: string;
  resuming?: boolean;
  timeoutMs: number;
  maxConcurrency: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  /** Parent-side inbox used for bounded feedback and checkpoint requests. */
  control?: DelegateControlChannel;
  onUpdate?: OnUpdate;
  /** In-process live status hook; raw runs never enter public tool details. */
  onRunUpdate?: (run: DelegatedRun) => void;
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
    | 'handoffText'
    | 'resultSpec'
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
    '--extension',
    MID_RUN_COMPACTION_EXTENSION,
    '--extension',
    TOOL_ARGUMENT_VALIDATION_EXTENSION,
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
      handoffText: options.handoffText,
      resultSpec: options.resultSpec,
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
  setDelegateResultSpec(run, options.resultSpec);
  const control =
    options.control ?? createDelegateControlChannel(options.sessionPath);
  let releaseSlot: (() => void) | undefined;
  let releaseSession: (() => void) | undefined;

  const emitUpdate = () => {
    options.onRunUpdate?.(run);
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
      env: {
        ...(options.worktree?.env ?? {}),
        PI_DELEGATE_CONTROL_FILE: control.filePath,
        ...(options.resultSpec
          ? {
              PI_DELEGATE_RESULT_SCHEMA: JSON.stringify(
                options.resultSpec.schema,
              ),
            }
          : {}),
      },
    };

    const { exitCode, wasAborted, timedOut, spawnError } =
      await spawnDelegateChild(run, {
        command: spawnTarget.command,
        args: spawnTarget.args,
        cwd: spawnTarget.cwd,
        env: spawnTarget.env,
        timeoutMs: options.timeoutMs,
        checkpointLeadMs: checkpointLeadMs(options.timeoutMs),
        killGraceMs: options.killGraceMs,
        signal: options.signal,
        onCheckpoint: () => {
          const requestedAt = Date.now();
          const queued = control.enqueue(
            'checkpoint',
            checkpointRequestMessage(),
          );
          run.checkpoint = {
            requestedAt,
            state: queued.accepted ? 'requested' : 'unavailable',
          };
          emitUpdate();
        },
        onLine: emitUpdate,
      });

    run.exitCode = exitCode;
    if (spawnError) {
      run.stopReason = 'error';
      run.errorMessage = `Delegate runner failed to start the child: ${spawnError}`;
      setDelegateLifecycle(run, 'provider-runner-error', run.errorMessage);
      run.state = 'error';
    }
    if (!spawnError && wasAborted) {
      run.stopReason = 'aborted';
      run.errorMessage = 'Delegated task was aborted.';
      setDelegateLifecycle(run, 'user-cancellation', run.errorMessage);
      run.state = 'aborted';
    } else if (!spawnError && timedOut) {
      run.stopReason = 'error';
      const checkpoint = run.checkpoint;
      if (checkpoint?.state === 'requested')
        run.checkpoint = { ...checkpoint, state: 'hard-timeout' };
      const checkpointStatus =
        checkpoint?.state === 'acknowledged'
          ? ' The child acknowledged a pre-timeout checkpoint; retained output/worktree is partial and requires review.'
          : checkpoint?.state === 'requested'
            ? ' A pre-timeout checkpoint was requested but not acknowledged; retained output/worktree is partial and requires review.'
            : checkpoint?.state === 'unavailable'
              ? ' The pre-timeout checkpoint request could not be queued; retained output/worktree is partial and requires review.'
              : '';
      run.errorMessage = `Delegated task timed out after ${Math.round(options.timeoutMs / 1000)} seconds.${checkpointStatus}`;
      setDelegateLifecycle(run, 'timeout', run.errorMessage);
      run.state = 'timed-out';
    } else if (!spawnError && exitCode !== 0) {
      // A child error event may have populated errorMessage before close. The
      // observed nonzero exit is still the stable lifecycle cause; that text
      // is evidence only, bounded inside the diagnostic.
      run.stopReason = 'error';
      run.errorMessage ||= `Child Pi exited with code ${exitCode}.`;
      setDelegateLifecycleText(
        run,
        'child-nonzero-exit',
        buildLifecycleDiagnostic(
          'child-nonzero-exit',
          run.errorMessage,
          run.stderr,
        ),
      );
    }
    if (run.state === 'running') {
      // Finalize the canonical state once; exitCode/stopReason remain
      // diagnostics after this transition rather than a render-time fallback.
      const failed =
        run.stopReason === 'error' ||
        run.stopReason === 'aborted' ||
        run.exitCode !== 0 ||
        (options.resultSpec
          ? !getDelegateChannelPresent(run)
          : !getFinalAssistantText(run.messages).trim());
      run.state = failed ? 'error' : 'success';
      if (failed && !getDelegateResultSpec(run) && !getDelegateLifecycle(run)) {
        run.stopReason = 'error';
        run.errorMessage ||=
          'The child exited without a final assistant response.';
        setDelegateLifecycleText(
          run,
          'unknown',
          buildLifecycleDiagnostic('unknown', run.errorMessage, run.stderr),
        );
      }
    }
  } catch (error) {
    const aborted = options.signal?.aborted ?? false;
    const queued = run.state === 'queued';
    run.exitCode = aborted ? 130 : 1;
    run.stopReason = aborted ? 'aborted' : 'error';
    run.errorMessage = aborted
      ? 'Delegated task was aborted.'
      : error instanceof Error
        ? error.message
        : String(error);
    setDelegateLifecycle(
      run,
      aborted
        ? queued
          ? 'queued-cancellation'
          : 'user-cancellation'
        : error instanceof Error
          ? 'provider-runner-error'
          : 'unknown',
      run.errorMessage,
    );
    run.state = aborted ? 'aborted' : 'error';
  } finally {
    if (updateTimer) clearInterval(updateTimer);
    run.finishedAt = Date.now();
    emitUpdate();
    releaseSlot?.();
    releaseSession?.();
    control.close();
  }
  return run;
}
