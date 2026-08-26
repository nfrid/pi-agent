import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { BackgroundJobsClient } from '@pi-agent/background-jobs';
import {
  createDelegateControlChannel,
  type DelegateControlChannel,
} from './control';
import type {
  DelegateJobManager,
  DelegateJobMaterializer,
  DelegateJobResult,
  DelegateJobSnapshot,
} from './jobs';
import { buildParentHandoff } from './output';
import {
  DetachedDelegateError,
  type RunDelegateOptions,
  runDelegate,
} from './runner';
import { type DelegateSession, resolveDelegateSession } from './session';
import { createRun, type DelegatedRun, type DelegateRouteState } from './types';
import type {
  DelegateRestorableHostedLink,
  DelegateWorkflowAttemptSnapshot,
  DelegateWorkflowCoordinator,
} from './workflow-coordinator';
import { isTerminalWorkflowAttemptState } from './workflow-model';
import {
  loadWorktree,
  type PreparedWorktree,
  restoreWorktreeSession,
  type WorktreeRecord,
  worktreeSummary,
} from './worktree';
import { failedLifecycleRun, finalizeWorktreeRun } from './worktree-lifecycle';

export type RestoreAttemptReference =
  | string
  | Pick<DelegateWorkflowAttemptSnapshot, 'identity'>
  | Pick<DelegateRestorableHostedLink, 'identity'>;

/** Trusted seams supplied by the owner runtime, kept injectable for restore tests. */
export interface RestoredDelegateDependencies {
  runDelegate?: typeof runDelegate;
  loadWorktree?: typeof loadWorktree;
  restoreWorktreeSession?: typeof restoreWorktreeSession;
  finalizeWorktreeRun?: typeof finalizeWorktreeRun;
  /** Existing output-file and parent-handoff materialization seam. */
  materialize?: (runs: DelegatedRun[]) => Promise<DelegateJobResult>;
  /** Feed restored live activity into the existing status store. */
  onRunUpdate?: (run: DelegatedRun) => void;
  /** Injectable bounded backoff seam for deterministic recovery tests. */
  waitForRetry?: typeof waitForRetry;
}

export interface RestoreHostedDelegateAttemptOptions {
  parentSessionId: string;
  attempt: RestoreAttemptReference;
  manager: DelegateJobManager;
  coordinator: DelegateWorkflowCoordinator;
  /** Stable metadata label only; it is never used as a new child prompt. */
  logicalAttemptLabel?: string;
  dependencies?: RestoredDelegateDependencies;
  /** Stop an already-hosted process when explicit cancellation wins a retry backoff. */
  stopExistingHost?: (processJobId: string) => Promise<void>;
}

export interface RestoredHostedDelegateAttempt {
  readonly session: DelegateSession;
  readonly control: DelegateControlChannel;
  readonly job: DelegateJobSnapshot;
  readonly worktree?: PreparedWorktree;
}

export type RestoreSessionFailureCode =
  | 'missing-session'
  | 'foreign-session'
  | 'invalid-session';

export class RestoreSessionError extends Error {
  readonly code: RestoreSessionFailureCode;

  constructor(code: RestoreSessionFailureCode, message: string) {
    super(message);
    this.name = 'RestoreSessionError';
    this.code = code;
  }
}

export class RestoreBindingConflictError extends Error {
  constructor(identity: string) {
    super(`Workflow attempt "${identity}" is already being restored or bound.`);
    this.name = 'RestoreBindingConflictError';
  }
}

function attemptIdentity(reference: RestoreAttemptReference): string {
  return typeof reference === 'string' ? reference : reference.identity;
}

/**
 * Resolve a persisted delegate token and verify both durable representations.
 * Metadata alone is insufficient: the JSONL header is the child-session
 * identity the host actually opened.
 */
export function resolveTrustedDelegateSession(
  token: string,
  parentSessionId: string,
): DelegateSession {
  const session = resolveDelegateSession(token);
  if (!session)
    throw new RestoreSessionError(
      'missing-session',
      `Delegate session "${token}" is missing or malformed.`,
    );
  if (session.parentSessionId !== parentSessionId)
    throw new RestoreSessionError(
      'foreign-session',
      `Delegate session "${token}" belongs to another parent session.`,
    );
  let header: Record<string, unknown>;
  try {
    const first = readFileSync(session.filePath, 'utf8')
      .split(/\r?\n/)
      .find((line) => line.trim());
    const parsed: unknown = first ? JSON.parse(first) : undefined;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('missing JSONL header');
    header = parsed as Record<string, unknown>;
  } catch {
    throw new RestoreSessionError(
      'invalid-session',
      `Delegate session "${token}" has an invalid JSONL header.`,
    );
  }
  if (
    header.type !== 'session' ||
    header.sessionKind !== 'delegate' ||
    header.id !== session.sessionId ||
    header.parentSessionId !== parentSessionId
  )
    throw new RestoreSessionError(
      'foreign-session',
      `Delegate session "${token}" failed its immutable identity or parent check.`,
    );
  return session;
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

const OBSERVE_RETRY_INITIAL_MS = 100;
const OBSERVE_RETRY_MAX_MS = 2_000;

function invalidWorktreeResult(
  label: string,
  processJobId: string,
  session: DelegateSession,
  record: WorktreeRecord | undefined,
  error: unknown,
): DelegateJobResult {
  const run = failedLifecycleRun(
    label,
    session.routing,
    {
      runId: processJobId,
      name: session.name ?? label,
      sessionId: session.sessionId,
      lineageId: session.lineageId,
      context: 'continuation',
      continuation: session.token,
      allowWrites: session.allowWrites === true,
      capabilities: session.capabilities ? [...session.capabilities] : [],
      isolation: session.isolation,
      worktree: record ? worktreeSummary(record) : undefined,
      warnings: [
        'The restored worktree was retained because its binding could not be verified.',
      ],
    },
    error,
    'setup-failure',
  );
  return { runs: [run], handoff: buildParentHandoff([run]) };
}

function fallbackMaterialize(runs: DelegatedRun[]): Promise<DelegateJobResult> {
  return Promise.resolve({
    runs,
    retainedRuns: runs,
    handoff: buildParentHandoff(runs),
  });
}

function retryDelay(attempt: number): number {
  return Math.min(
    OBSERVE_RETRY_MAX_MS,
    OBSERVE_RETRY_INITIAL_MS * 2 ** Math.max(0, attempt - 1),
  );
}

async function waitForRetry(
  delayMs: number,
  signal: AbortSignal,
  detachSignal: AbortSignal | undefined,
): Promise<'retry' | 'cancel' | 'detach'> {
  if (detachSignal?.aborted) return 'detach';
  if (signal.aborted) return 'cancel';
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: 'retry' | 'cancel' | 'detach') => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      detachSignal?.removeEventListener('abort', detach);
      resolve(outcome);
    };
    const cancel = () => finish('cancel');
    const detach = () => finish('detach');
    signal.addEventListener('abort', cancel, { once: true });
    detachSignal?.addEventListener('abort', detach, { once: true });
    timer = setTimeout(() => finish('retry'), delayMs);
    timer.unref();
  });
}

function cancelledObservationResult(
  label: string,
  processJobId: string,
  session: DelegateSession,
): DelegateJobResult {
  const run = createRun(label, session.routing, {
    runId: processJobId,
    name: session.name ?? label,
    sessionId: session.sessionId,
    lineageId: session.lineageId,
    context: 'continuation',
    continuation: session.token,
    allowWrites: session.allowWrites === true,
    capabilities: session.capabilities ? [...session.capabilities] : [],
    isolation: session.isolation,
  });
  run.state = 'aborted';
  run.exitCode = 130;
  run.stopReason = 'aborted';
  run.errorMessage = 'Delegated task was aborted.';
  run.finishedAt = Date.now();
  return { runs: [run], handoff: buildParentHandoff([run]) };
}

function lifecycleFailureResult(
  label: string,
  processJobId: string,
  session: DelegateSession,
  attempt: DelegateWorkflowAttemptSnapshot['attempt'],
  worktree: PreparedWorktree | undefined,
  error: unknown,
): DelegateJobResult {
  const run = failedLifecycleRun(
    label,
    session.routing,
    {
      runId: processJobId,
      name: session.name ?? label,
      sessionId: session.sessionId,
      lineageId: session.lineageId,
      workflowAttempt: attempt,
      context: 'continuation',
      continuation: session.token,
      allowWrites: session.allowWrites === true,
      capabilities: session.capabilities ? [...session.capabilities] : [],
      isolation: session.isolation,
      ...(worktree
        ? {
            worktree: worktreeSummary(worktree.record),
            warnings: [
              'The restored worktree was retained after lifecycle materialization failed.',
            ],
          }
        : {}),
    },
    error,
    'lifecycle-cleanup-failure',
  );
  return { runs: [run], handoff: buildParentHandoff([run]) };
}

/**
 * Observe one durable hosted delegate without scheduling a new workflow or
 * sending a start request to the process host.
 */
export function restoreHostedDelegateAttempt(
  options: RestoreHostedDelegateAttemptOptions,
): RestoredHostedDelegateAttempt {
  const identity = attemptIdentity(options.attempt);
  const link = options.coordinator
    .listRestorableHostedLinks()
    .find((candidate) => candidate.identity === identity);
  if (!link) {
    const current = options.coordinator.get(identity);
    if (
      current &&
      !isTerminalWorkflowAttemptState(current.state) &&
      current.jobId !== undefined
    )
      throw new RestoreBindingConflictError(identity);
    throw new Error(
      `Workflow attempt "${identity}" has no valid local nonterminal hosted link.`,
    );
  }
  const session = resolveTrustedDelegateSession(
    link.sessionId,
    options.parentSessionId,
  );
  const dependencies = options.dependencies ?? {};
  const load = dependencies.loadWorktree ?? loadWorktree;
  const restore = dependencies.restoreWorktreeSession ?? restoreWorktreeSession;
  const finalize = dependencies.finalizeWorktreeRun ?? finalizeWorktreeRun;
  const observe = dependencies.runDelegate ?? runDelegate;
  const label =
    options.logicalAttemptLabel?.trim() ||
    `${link.logicalId}@${link.attempt.ordinal}`;
  let worktree: PreparedWorktree | undefined;
  let worktreeRecord: WorktreeRecord | undefined;
  let worktreeError: unknown;
  if (session.worktreeId !== undefined) {
    try {
      worktreeRecord = load(session.worktreeId);
    } catch (error) {
      worktreeError = error;
    }
    if (!worktreeRecord && !worktreeError)
      worktreeError = new Error(
        `Delegate session "${session.token}" references a missing worktree.`,
      );
    else if (worktreeRecord) {
      try {
        worktree = restore(worktreeRecord, session.token);
        const cwd = path.join(
          worktree.record.worktreePath,
          worktree.record.workingDirectory,
        );
        if (!pathInside(worktree.record.worktreePath, cwd))
          throw new Error(
            'The restored worktree working directory escapes its root.',
          );
      } catch (error) {
        worktreeError = error;
        worktree = undefined;
      }
    }
  }
  const control = createDelegateControlChannel(
    session.filePath,
    options.parentSessionId,
    'background',
    link.processJobId,
  );
  const materialize = dependencies.materialize ?? fallbackMaterialize;
  const stopExistingHost =
    options.stopExistingHost ??
    (async (processJobId: string) => {
      try {
        await new BackgroundJobsClient(undefined, options.parentSessionId).stop(
          [processJobId],
        );
      } catch {
        // Cancellation remains authoritative even when the host socket is down.
      }
    });
  const execute = async (
    signal: AbortSignal,
    detachSignal?: AbortSignal,
  ): Promise<DelegateJobResult> => {
    const runOptions: RunDelegateOptions = {
      runId: link.processJobId,
      workflowAttempt: link.attempt,
      processJobId: link.processJobId,
      sessionId: session.sessionId,
      lineageId: session.lineageId,
      cwd: worktree
        ? path.join(
            worktree.record.worktreePath,
            worktree.record.workingDirectory,
          )
        : session.cwd,
      name: session.name ?? label,
      // The host already owns the prompt. This is a logical label for the
      // restored run record, not reconstructed task text.
      task: label,
      context: 'continuation',
      sessionPath: session.filePath,
      ownerSessionId: options.parentSessionId,
      routing: session.routing as DelegateRouteState | undefined,
      allowWrites: session.allowWrites === true,
      writeRequested: session.allowWrites === true,
      capabilities: session.capabilities ? [...session.capabilities] : [],
      isolation: session.isolation,
      worktree,
      continuation: session.token,
      resuming: true,
      scope: session.scope,
      timeoutMs: 0,
      maxConcurrency: 1,
      signal,
      detachSignal,
      hosted: true,
      observeExisting: true,
      control,
      preserveControlOnRetry: true,
      onRunUpdate: dependencies.onRunUpdate,
      mode: 'single',
    };
    const notifyRun = (result: DelegateJobResult): void => {
      const run = result.runs[0];
      if (run) dependencies.onRunUpdate?.(run);
    };
    const cancellationResult = (): DelegateJobResult => {
      const result = cancelledObservationResult(
        label,
        link.processJobId,
        session,
      );
      notifyRun(result);
      return result;
    };
    const materializeResult = async (
      runs: DelegatedRun[],
    ): Promise<DelegateJobResult> => {
      if (detachSignal?.aborted) throw new DetachedDelegateError();
      if (signal.aborted) return cancellationResult();
      let result: DelegateJobResult;
      try {
        result = await materialize(runs);
      } catch (error) {
        // An output-file/materialization failure is a workflow failure, not
        // an unreported exception after the status row has already succeeded.
        if (detachSignal?.aborted) throw new DetachedDelegateError();
        if (signal.aborted) return cancellationResult();
        const failure = lifecycleFailureResult(
          label,
          link.processJobId,
          session,
          link.attempt,
          worktree,
          error,
        );
        notifyRun(failure);
        return failure;
      }
      if (detachSignal?.aborted) throw new DetachedDelegateError();
      if (signal.aborted) return cancellationResult();
      const run = result.runs[0] ?? runs[0];
      if (run) dependencies.onRunUpdate?.(run);
      return result;
    };
    const finish = async (run: DelegatedRun): Promise<DelegateJobResult> => {
      if (detachSignal?.aborted) throw new DetachedDelegateError();
      if (signal.aborted) return cancellationResult();
      if (run.state === 'aborted') return materializeResult([run]);
      if (worktreeError) {
        // Reconciliation was still performed, but an untrusted checkout can
        // never be finalized or treated as a successful recovery.
        const recovery = invalidWorktreeResult(
          label,
          link.processJobId,
          session,
          worktreeRecord,
          worktreeError,
        );
        return materializeResult(recovery.runs);
      }
      if (worktree) {
        if (detachSignal?.aborted) throw new DetachedDelegateError();
        if (signal.aborted) return cancellationResult();
        try {
          await finalize(run, worktree, label);
        } catch (error) {
          if (detachSignal?.aborted) throw new DetachedDelegateError();
          if (signal.aborted) return cancellationResult();
          const failure = lifecycleFailureResult(
            label,
            link.processJobId,
            session,
            link.attempt,
            worktree,
            error,
          );
          notifyRun(failure);
          return failure;
        }
        if (detachSignal?.aborted) throw new DetachedDelegateError();
        if (signal.aborted) return cancellationResult();
      }
      return materializeResult([run]);
    };
    try {
      let retryCount = 0;
      while (true) {
        if (detachSignal?.aborted) throw new DetachedDelegateError();
        if (signal.aborted) {
          await stopExistingHost(link.processJobId);
          return cancellationResult();
        }
        const run = await observe(runOptions);
        if (!run.retryable) return finish(run);
        retryCount++;
        const outcome = await (dependencies.waitForRetry ?? waitForRetry)(
          retryDelay(retryCount),
          signal,
          detachSignal,
        );
        if (outcome === 'detach') throw new DetachedDelegateError();
        if (outcome === 'cancel') {
          await stopExistingHost(link.processJobId);
          return cancellationResult();
        }
      }
    } finally {
      if (detachSignal?.aborted) control.detach();
      else control.close();
    }
  };
  let job: DelegateJobSnapshot | undefined;
  let claimHeld = false;
  try {
    claimHeld = options.coordinator.claimRestoredHostedJob(identity);
    if (!claimHeld) throw new RestoreBindingConflictError(identity);
    job = options.manager.observeExisting({
      name: session.name ?? label,
      ownerBranchId: link.ownerBranchId,
      mode: 'single',
      tasks: [label],
      workflowAttempt: link.attempt,
      detachOnTeardown: true,
      processJobId: link.processJobId,
      sessionId: session.sessionId,
      allowWrites: session.allowWrites,
      capabilities: session.capabilities
        ? [...session.capabilities]
        : undefined,
      route: session.routing?.route,
      feedback: (message) => control.enqueue('feedback', message),
      execute,
      onTerminal: (result, snapshot) =>
        options.coordinator.acceptRestoredHostedTerminal(
          identity,
          snapshot,
          result,
        ),
    });
    options.coordinator.bindRestoredHostedJob(identity, job);
    claimHeld = false;
    return { session, control, job, ...(worktree ? { worktree } : {}) };
  } catch (error) {
    if (job) void options.manager.cancel([job.id]).catch(() => undefined);
    if (claimHeld) options.coordinator.releaseRestoredHostedJobClaim(identity);
    control.close();
    throw error;
  }
}

export interface ReconcileRestoredHostedAttemptsOptions {
  parentSessionId: string;
  manager: DelegateJobManager;
  coordinator: DelegateWorkflowCoordinator;
  /** False when a replaced session runtime must stop mutating its records. */
  isGenerationActive?: () => boolean;
  logicalAttemptLabel?: (link: DelegateRestorableHostedLink) => string;
  dependencies?: RestoredDelegateDependencies;
  stopExistingHost?: (processJobId: string) => Promise<void>;
  onRestored?: (
    restored: RestoredHostedDelegateAttempt,
    link: DelegateRestorableHostedLink,
  ) => void;
  onFailure?: (
    link: DelegateRestorableHostedLink,
    attempt: DelegateWorkflowAttemptSnapshot,
  ) => void;
}

/**
 * Reconcile the active owner's persisted links once. Validation failures are
 * reduced to bounded workflow failures; imported/foreign records are never
 * reachable through the coordinator link enumeration.
 */
export function reconcileRestoredHostedAttempts(
  options: ReconcileRestoredHostedAttemptsOptions,
): RestoredHostedDelegateAttempt[] {
  const restored: RestoredHostedDelegateAttempt[] = [];
  for (const link of options.coordinator.listRestorableHostedLinks()) {
    if (options.isGenerationActive && !options.isGenerationActive()) break;
    try {
      const observation = restoreHostedDelegateAttempt({
        parentSessionId: options.parentSessionId,
        attempt: link.identity,
        manager: options.manager,
        coordinator: options.coordinator,
        logicalAttemptLabel: options.logicalAttemptLabel?.(link),
        dependencies: options.dependencies,
        stopExistingHost: options.stopExistingHost,
      });
      restored.push(observation);
      options.onRestored?.(observation, link);
    } catch (error) {
      if (error instanceof RestoreBindingConflictError) continue;
      if (options.isGenerationActive && !options.isGenerationActive()) break;
      const failureState =
        error instanceof RestoreSessionError &&
        (error.code === 'missing-session' || error.code === 'foreign-session')
          ? 'blocked'
          : 'error';
      const attempt = options.coordinator.settleRestoredFailure(
        link.identity,
        failureState,
        error instanceof Error ? error.message : String(error),
      );
      options.onFailure?.(link, attempt);
    }
  }
  return restored;
}

/** Short integration name retained for the parent runtime adapter. */
export const observeRestoredDelegateAttempt = restoreHostedDelegateAttempt;

/** Type-only check that the manager materializer seam remains compatible. */
export type RestoredMaterializer = DelegateJobMaterializer;
