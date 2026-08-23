import { readFileSync } from 'node:fs';
import * as path from 'node:path';
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
import { type RunDelegateOptions, runDelegate } from './runner';
import { type DelegateSession, resolveDelegateSession } from './session';
import type { DelegatedRun, DelegateRouteState } from './types';
import type {
  DelegateRestorableHostedLink,
  DelegateWorkflowAttemptSnapshot,
  DelegateWorkflowCoordinator,
} from './workflow-coordinator';
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
  /** Existing owner-session artifact/handoff materialization seam. */
  materialize?: (runs: DelegatedRun[]) => Promise<DelegateJobResult>;
}

export interface RestoreHostedDelegateAttemptOptions {
  parentSessionId: string;
  attempt: RestoreAttemptReference;
  manager: DelegateJobManager;
  coordinator: DelegateWorkflowCoordinator;
  /** Stable metadata label only; it is never used as a new child prompt. */
  logicalAttemptLabel?: string;
  dependencies?: RestoredDelegateDependencies;
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

function invalidWorktreeResult(
  label: string,
  session: DelegateSession,
  record: WorktreeRecord | undefined,
  error: unknown,
): DelegateJobResult {
  const run = failedLifecycleRun(
    label,
    session.routing,
    {
      runId: session.sessionId,
      name: session.name ?? label,
      sessionId: session.sessionId,
      lineageId: session.lineageId,
      context: 'continuation',
      continuation: session.token,
      allowWrites: session.allowWrites === true,
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
  if (!link)
    throw new Error(
      `Workflow attempt "${identity}" has no valid local nonterminal hosted link.`,
    );
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
  if (worktreeError) {
    // Do not remove, rewrite, or rehydrate an untrusted binding.
    const control = createDelegateControlChannel(
      session.filePath,
      options.parentSessionId,
      'background',
      link.processJobId,
    );
    try {
      const job = options.manager.observeExisting({
        name: session.name ?? label,
        ownerSessionId: options.parentSessionId,
        ownerBranchId: link.ownerBranchId,
        mode: 'single',
        tasks: [label],
        workflowAttempt: link.attempt,
        detachOnTeardown: true,
        processJobId: link.processJobId,
        sessionId: session.sessionId,
        allowWrites: session.allowWrites,
        route: session.routing?.route,
        execute: async (_signal, detachSignal) => {
          try {
            return invalidWorktreeResult(
              label,
              session,
              worktreeRecord,
              worktreeError,
            );
          } finally {
            if (detachSignal?.aborted) control.detach();
            else control.close();
          }
        },
        onTerminal: (result, snapshot) =>
          options.coordinator.acceptRestoredHostedTerminal(
            identity,
            snapshot,
            result,
          ),
      });
      options.coordinator.bindRestoredHostedJob(identity, job);
      return { session, control, job, worktree: undefined };
    } catch (error) {
      control.close();
      throw error;
    }
  }

  const control = createDelegateControlChannel(
    session.filePath,
    options.parentSessionId,
    'background',
    link.processJobId,
  );
  const materialize = dependencies.materialize ?? fallbackMaterialize;
  const execute = async (
    signal: AbortSignal,
    detachSignal?: AbortSignal,
  ): Promise<DelegateJobResult> => {
    const runOptions: RunDelegateOptions = {
      runId: session.sessionId,
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
      mode: 'single',
    };
    try {
      const run = await observe(runOptions);
      if (worktree) await finalize(run, worktree, label);
      return await materialize([run]);
    } finally {
      if (detachSignal?.aborted) control.detach();
      else control.close();
    }
  };
  try {
    const job = options.manager.observeExisting({
      name: session.name ?? label,
      ownerSessionId: options.parentSessionId,
      ownerBranchId: link.ownerBranchId,
      mode: 'single',
      tasks: [label],
      workflowAttempt: link.attempt,
      detachOnTeardown: true,
      processJobId: link.processJobId,
      sessionId: session.sessionId,
      allowWrites: session.allowWrites,
      route: session.routing?.route,
      execute,
      onTerminal: (result, snapshot) =>
        options.coordinator.acceptRestoredHostedTerminal(
          identity,
          snapshot,
          result,
        ),
    });
    options.coordinator.bindRestoredHostedJob(identity, job);
    return { session, control, job, ...(worktree ? { worktree } : {}) };
  } catch (error) {
    control.close();
    throw error;
  }
}

/** Short integration name retained for the parent runtime adapter. */
export const observeRestoredDelegateAttempt = restoreHostedDelegateAttempt;

/** Type-only check that the manager materializer seam remains compatible. */
export type RestoredMaterializer = DelegateJobMaterializer;
