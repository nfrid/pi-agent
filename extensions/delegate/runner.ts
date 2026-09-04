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
  runHostedDelegateChild,
  spawnDelegateChild,
} from './delegate-child';
import {
  buildLifecycleDiagnostic,
  getDelegateLifecycle,
  setDelegateLifecycle,
  setDelegateLifecycleText,
} from './lifecycle';
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
} from './types';
import { type PreparedWorktree, worktreeSummary } from './worktree';

// Read-only is an intent signal, not an enforced boundary: the child still has
// bash, so it can inspect the repository the same way any agent would.
const READ_ONLY_TOOLS = ['read', 'bash', 'grep', 'find', 'ls'] as const;
const WRITE_TOOLS = [
  'read',
  'edit',
  'write',
  'bash',
  'grep',
  'find',
  'ls',
] as const;
const WEB_TOOLS = [
  'web_search',
  'fetch_content',
  'get_search_content',
] as const;
const DELEGATE_EXTENSION = path.resolve(__dirname, 'index.ts');
const REMOTE_CONTROL_EXTENSION = path.resolve(
  __dirname,
  '../remote-control/index.ts',
);
const SYSTEM_PROMPT_EXTENSION = path.resolve(
  __dirname,
  '../system-prompt/index.ts',
);
const MID_RUN_COMPACTION_EXTENSION = path.resolve(
  __dirname,
  '../mid-run-compaction/index.ts',
);
const CODEX_SERVICE_TIER_EXTENSION = path.resolve(
  __dirname,
  '../codex-service-tier/index.ts',
);
const WEB_EXTENSION = path.resolve(__dirname, '../web/index.ts');
const TOOL_ARGUMENT_VALIDATION_EXTENSION = path.resolve(
  __dirname,
  '../tool-argument-validation/index.ts',
);
const BASH_DESCRIPTION_EXTENSION = path.resolve(
  __dirname,
  '../bash-description/index.ts',
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
  /** Stable invocation identity allocated during preparation. */
  runId?: string;
  /** Session-scoped workflow identity used by restored status hooks. */
  workflowAttempt?: import('./workflow-model').WorkflowAttempt;
  /** Durable process-host job identity; normally the prepared run ID. */
  processJobId?: string;
  /** Canonical Pi child session used by dashboard session APIs. */
  sessionId?: string;
  /** Stable child-session lineage from the prepared durable session. */
  lineageId?: string;
  cwd: string;
  name?: string;
  task: string;
  context: DelegateContext;
  sessionPath: string;
  /** Parent session that owns this delegate control channel. */
  ownerSessionId?: string;
  routing?: DelegateRouteState;
  serviceTier?: import('../shared/codex-service-tier').CodexServiceTier;
  allowWrites?: boolean;
  writeRequested?: boolean;
  capabilities?: import('./types').DelegateChildCapability[];
  skills?: string[];
  isolation: DelegateIsolation;
  worktree?: PreparedWorktree;
  contextNote?: string;
  /** Resolved upstream evidence, never included in parent-visible run details. */
  handoffText?: string;
  /** Bounded evidence metadata used to explain the resolved prompt inputs. */
  inputEvidence?: readonly import('./types').DelegateInputEvidence[];
  scope?: string[];
  refreshSource?: import('./worktree/model').WorktreeBase;
  continuation?: string;
  resuming?: boolean;
  timeoutMs: number;
  maxConcurrency: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  /** Manager teardown detaches a hosted process instead of stopping it. */
  detachSignal?: AbortSignal;
  /** Use the durable process host rather than the direct foreground spawn. */
  hosted?: boolean;
  /** Reattach to an already-started durable host job; never sends start. */
  observeExisting?: boolean;
  /** Parent-side inbox used for bounded feedback and checkpoint requests. */
  control?: DelegateControlChannel;
  /** Keep the supplied control inbox open after a retryable host transport error. */
  preserveControlOnRetry?: boolean;
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
    | 'serviceTier'
    | 'allowWrites'
    | 'capabilities'
    | 'skills'
    | 'worktree'
    | 'contextNote'
    | 'handoffText'
    | 'scope'
    | 'resuming'
  > & { timeoutMs?: number; hosted?: boolean },
  sessionPath: string,
): string[] {
  const allowWrites = options.allowWrites === true;
  if (allowWrites && !options.worktree)
    throw new Error('Writable delegates require a prepared worktree.');
  const baseTools = allowWrites ? WRITE_TOOLS : READ_ONLY_TOOLS;
  const webEnabled = options.capabilities?.includes('web') === true;
  const tools = [...baseTools, ...(webEnabled ? WEB_TOOLS : [])].join(',');
  const args = [
    '--mode',
    'json',
    '-p',
    '--no-extensions',
    '--extension',
    DELEGATE_EXTENSION,
    ...(options.hosted ? ['--extension', REMOTE_CONTROL_EXTENSION] : []),
    '--extension',
    SYSTEM_PROMPT_EXTENSION,
    ...(webEnabled ? ['--extension', WEB_EXTENSION] : []),
    '--extension',
    MID_RUN_COMPACTION_EXTENSION,
    ...(options.routing?.provider === 'openai-codex'
      ? ['--extension', CODEX_SERVICE_TIER_EXTENSION]
      : []),
    '--extension',
    TOOL_ARGUMENT_VALIDATION_EXTENSION,
    '--extension',
    BASH_DESCRIPTION_EXTENSION,
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--tools',
    tools,
  ];
  args.push('--session', sessionPath);
  for (const skill of options.skills ?? []) args.push('--skill', skill);
  if (options.routing) {
    args.push('--provider', options.routing.provider);
    args.push('--model', options.routing.model);
    args.push('--thinking', options.routing.thinking);
    if (options.routing.provider === 'openai-codex')
      args.push('--service-tier', options.serviceTier ?? 'normal');
  }
  args.push(
    buildDelegatePrompt(options.task, {
      allowWrites,
      contextNote: options.contextNote,
      handoffText: options.handoffText,
      scope: options.scope,
      continuation: options.resuming,
      timeoutMs: options.timeoutMs,
      branch: options.worktree?.record.branch,
    }),
  );
  return args;
}

export class DetachedDelegateError extends Error {
  constructor() {
    super('Hosted delegate was detached from its parent session.');
    this.name = 'DetachedDelegateError';
  }
}

function boundedDisplayTitle(name: string | undefined): string {
  const title = `Delegate: ${name?.trim() || 'Subagent'}`;
  return title.length <= 240 ? title : `${title.slice(0, 239)}…`;
}

export async function runDelegate(
  options: RunDelegateOptions,
): Promise<DelegatedRun> {
  const writeRequested = options.writeRequested ?? options.allowWrites ?? false;
  const allowWrites = options.allowWrites === true;
  const run = createRun(options.task, options.routing, {
    runId: options.runId,
    workflowAttempt: options.workflowAttempt,
    sessionId: options.sessionId,
    lineageId: options.lineageId,
    name: options.name,
    cwd: options.cwd,
    context: options.context,
    allowWrites,
    writeRequested,
    capabilities: options.capabilities ? [...options.capabilities] : [],
    isolation: options.isolation,
    worktree: options.worktree
      ? worktreeSummary(options.worktree.record)
      : undefined,
    contextNote: options.contextNote,
    scope: options.scope,
    continuation: options.continuation,
    inputEvidence: options.inputEvidence,
    refreshSource: options.refreshSource,
  });
  const control =
    options.control ??
    createDelegateControlChannel(options.sessionPath, options.ownerSessionId);
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
    // An observed host row supplies the already-running command. Avoid even
    // reconstructing a prompt/argv from restored metadata; the host adapter
    // ignores these placeholders and must never receive a fresh start.
    const args = options.observeExisting
      ? []
      : buildChildArgs(options, options.sessionPath);
    if (!options.observeExisting) {
      const renderedPrompt = args.at(-1);
      if (renderedPrompt) {
        run.renderedPrompt = renderedPrompt;
        // The exact prompt becomes known only after argv construction; publish
        // it immediately so the live inspector does not wait for a timer tick.
        emitUpdate();
      }
    }
    const dashboardEnv = options.hosted
      ? Object.fromEntries(
          ['PI_DASHBOARD_SOCKET', 'PI_DASHBOARD_STATE_DIR']
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key] as string]),
        )
      : {};
    const spawnTarget = {
      command,
      args: [...prefixArgs, ...args],
      cwd: options.cwd,
      env: {
        ...(options.worktree?.env ?? {}),
        ...dashboardEnv,
        ...(options.hosted
          ? { PI_DASHBOARD_EXTERNAL_RUNTIME_ID: run.runId }
          : {}),
        PI_DELEGATE_CONTROL_FILE: control.filePath,
      },
    };

    const acknowledgeControl = (
      id: string,
      kind: string,
      generation?: number,
    ) =>
      control.acknowledge(
        id,
        kind as import('./control').DelegateControlKind,
        generation,
      );
    const childRunner = options.hosted
      ? runHostedDelegateChild
      : spawnDelegateChild;
    const childResult = await childRunner(run, {
      command: spawnTarget.command,
      title: boundedDisplayTitle(options.name),
      args: spawnTarget.args,
      cwd: spawnTarget.cwd,
      env: spawnTarget.env,
      timeoutMs: options.timeoutMs,
      checkpointLeadMs: checkpointLeadMs(options.timeoutMs),
      killGraceMs: options.killGraceMs,
      signal: options.signal,
      detachSignal: options.detachSignal,
      processJobId: options.processJobId ?? run.runId,
      ownerSession: options.ownerSessionId,
      observeExisting: options.observeExisting,
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
      onControlAck: acknowledgeControl,
      onLine: emitUpdate,
    });

    if (childResult.detached) throw new DetachedDelegateError();
    const { exitCode, wasAborted, timedOut, spawnError, hostError, retryable } =
      childResult;
    if (retryable) run.retryable = true;
    const lifecycleStderr = [
      hostError ? `Process-host terminal error: ${hostError}` : '',
      run.stderr,
    ]
      .filter(Boolean)
      .join('\n');
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
      run.errorMessage ||= retryable
        ? `Retryable process-host error: ${hostError ?? `child exited with code ${exitCode}`}.`
        : `Child Pi exited with code ${exitCode}.`;
      setDelegateLifecycleText(
        run,
        'child-nonzero-exit',
        buildLifecycleDiagnostic(
          'child-nonzero-exit',
          run.errorMessage,
          lifecycleStderr,
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
        !getFinalAssistantText(run.messages).trim();
      run.state = failed ? 'error' : 'success';
      if (failed && !getDelegateLifecycle(run)) {
        run.stopReason = 'error';
        run.errorMessage ||=
          'The child exited without a final assistant response.';
        setDelegateLifecycleText(
          run,
          'unknown',
          buildLifecycleDiagnostic(
            'unknown',
            run.errorMessage,
            lifecycleStderr,
          ),
        );
      }
    }
  } catch (error) {
    if (error instanceof DetachedDelegateError) throw error;
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
    const detached = options.detachSignal?.aborted === true;
    if (!detached) {
      run.finishedAt = Date.now();
      emitUpdate();
    }
    releaseSlot?.();
    releaseSession?.();
    if (detached) control.detach();
    else if (!(options.preserveControlOnRetry && run.retryable))
      control.close();
  }
  return run;
}
