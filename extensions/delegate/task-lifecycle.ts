import * as path from 'node:path';
import { createOpaqueId } from './identity';
import { persistSessionRoute, removeSessionSafely } from './routing-warnings';
import { type RunDelegateOptions, runDelegate } from './runner';
import {
  createDelegateSession,
  type DelegateSession,
  updateDelegateSessionRouting,
  updateDelegateSessionWorktree,
} from './session';
import type { DelegateHandoffFrom } from './tool';
import type {
  DelegateContext,
  DelegatedRun,
  DelegateIsolation,
  DelegateRouteState,
} from './types';
import {
  attachWorktreeSession,
  discardFreshWorktree,
  loadWorktree,
  type PreparedWorktree,
  prepareWorktree,
  rehydrateWorktreeSession,
  removeWorktree,
  restoreWorktreeSession,
  touchWorktreeParentSession,
  validateExistingWorktree,
  type WorktreeBase,
  type WorktreeRecord,
  writeWorktreeRecord,
} from './worktree';

export interface DelegateTaskPlan {
  name: string;
  task: string;
  requestedCwd: string;
  /** Whether cwd was explicitly supplied rather than inherited from ctx. */
  cwdExplicit?: boolean;
  context: DelegateContext;
  contextNote?: string;
  scope?: string[];
  base?: WorktreeBase;
  /** Exact immutable commit/ref supplied by a symbolic branch input. */
  baseRef?: string;
  /** Relative working directory captured from a symbolic branch input. */
  workingDirectory?: string;
  /** Existing caller-owned checkout selected for a fresh task. */
  worktreePath?: string;
  /** Explicit source for a read-only continuation replacement snapshot. */
  refresh?: WorktreeBase;
  /** Parent-owned artifact reference resolved before child setup. */
  handoffFrom?: DelegateHandoffFrom[];
  /** Resolved artifact text, kept out of run details. */
  handoffText?: string;
  writeRequested: boolean;
  /** Effective workspace isolation, independent from write capability. */
  isolation: DelegateIsolation;
  /** Whether this invocation explicitly supplied allowWrites. */
  allowWritesExplicit?: boolean;
  /** Whether this invocation explicitly supplied isolation. */
  isolationExplicit?: boolean;
  routing?: DelegateRouteState;
  resumed?: DelegateSession;
  routeOverride: boolean;
  snapshotJsonl?: string;
  warnings: string[];
}

export interface ContinuationPreflight {
  cwd: string;
  scope?: string[];
  allowWrites: boolean;
  isolation: DelegateIsolation;
  worktree?: PreparedWorktree;
  refreshSource?: WorktreeRecord;
  snapshotNotice?: string;
  warnings: string[];
}

export interface PreparedDelegateTask extends ContinuationPreflight {
  /** Stable identity for this prepared invocation, reused by live/public views. */
  runId: string;
  plan: DelegateTaskPlan;
  /** Setup failed before a child run could be created. */
  setupFailure?: unknown;
  session: DelegateSession;
  routeRollback?: { routing?: DelegateRouteState };
}

export function preflightDelegateContinuation(
  plan: DelegateTaskPlan,
): ContinuationPreflight {
  const state: ContinuationPreflight = {
    cwd: plan.requestedCwd,
    scope: plan.scope,
    allowWrites: plan.writeRequested,
    isolation: plan.isolation,
    warnings: [...plan.warnings],
  };
  // A continuation cannot restate scope, so replay what the original run was
  // told to focus on.
  if (plan.resumed?.scope?.length) state.scope = plan.resumed.scope;
  if (plan.resumed) {
    // Worktree-linked sessions created before capability persistence were
    // writable, so preserve that behavior for their continuations.
    const originalAllowWrites =
      plan.resumed.allowWrites ?? Boolean(plan.resumed.worktreeId);
    if (
      plan.allowWritesExplicit &&
      plan.writeRequested !== originalAllowWrites
    ) {
      throw new Error(
        `A continuation cannot change allowWrites from ${originalAllowWrites ? 'writable' : 'read-only'} to ${plan.writeRequested ? 'writable' : 'read-only'}. Omit allowWrites to reuse the original capability.`,
      );
    }
    state.allowWrites = originalAllowWrites;
    const originalIsolation = plan.resumed.isolation;
    if (plan.isolationExplicit && plan.isolation !== originalIsolation) {
      throw new Error(
        `A continuation cannot change isolation from ${originalIsolation} to ${plan.isolation}. Omit isolation to reuse the original workspace mode.`,
      );
    }
    state.isolation = originalIsolation;
    if (
      plan.refresh &&
      (originalAllowWrites || originalIsolation !== 'worktree')
    )
      throw new Error(
        'refresh is only available on a read-only worktree continuation.',
      );
    if (originalIsolation === 'worktree') {
      if (!plan.resumed.worktreeId)
        throw new Error('The worktree for this continuation is unavailable.');
      const record = loadWorktree(plan.resumed.worktreeId);
      if (!record)
        throw new Error('The worktree for this continuation is unavailable.');
      if (plan.refresh) {
        if (record.ownership === 'caller')
          throw new Error(
            'refresh cannot replace a caller-owned worktree; continue the selected path or start a fresh delegate.',
          );
        if (
          !record.snapshot ||
          record.status !== 'finished' ||
          record.error ||
          record.runOutcome
        )
          throw new Error(
            'refresh requires a clean retired read-only snapshot; diagnostic worktrees remain available for recovery.',
          );
        state.refreshSource = record;
        state.cwd = path.join(record.repositoryRoot, record.workingDirectory);
      } else {
        state.worktree = record.snapshot
          ? { record, env: { PI_DELEGATE_WORKTREE: record.id } }
          : restoreWorktreeSession(record, plan.resumed.token);
        state.cwd = path.join(record.worktreePath, record.workingDirectory);
      }
    }
  }
  return state;
}

export async function prepareDelegateTask(
  plan: DelegateTaskPlan,
  preflight = preflightDelegateContinuation(plan),
  parentSessionId?: string,
  signal?: AbortSignal,
): Promise<PreparedDelegateTask> {
  const state = { ...preflight, warnings: [...preflight.warnings] };
  let session: DelegateSession | undefined;
  let replacement: PreparedWorktree | undefined;
  let replacementSessionMapped = false;
  let routeRollback: { routing?: DelegateRouteState } | undefined;
  try {
    if (plan.isolation === 'worktree' && !plan.resumed) {
      const prepared = await prepareWorktree({
        cwd: plan.requestedCwd,
        name: plan.name,
        base: plan.base,
        baseRef: plan.baseRef,
        worktreePath: plan.worktreePath,
        parentSessionId,
        signal,
      });
      if (prepared.worktree && plan.workingDirectory !== undefined) {
        const root = prepared.worktree.record.worktreePath;
        const workingDirectory = path.normalize(plan.workingDirectory);
        if (
          path.isAbsolute(workingDirectory) ||
          workingDirectory === '..' ||
          workingDirectory.startsWith(`..${path.sep}`)
        )
          throw new Error('Symbolic branch working directory is unsafe.');
        const record = {
          ...prepared.worktree.record,
          workingDirectory,
        };
        writeWorktreeRecord(record);
        state.worktree = { ...prepared.worktree, record };
        state.cwd = path.join(root, workingDirectory);
      }
      if (!prepared.worktree)
        throw new Error(
          prepared.fallbackReason ?? 'Worktree setup failed before launch.',
        );
      if (!state.worktree) state.worktree = prepared.worktree;
      if (plan.workingDirectory === undefined)
        state.cwd = path.join(
          prepared.worktree.record.worktreePath,
          prepared.worktree.record.workingDirectory,
        );
    }

    if (plan.resumed && state.worktree?.record.ownership === 'caller') {
      await validateExistingWorktree({
        cwd: state.worktree.record.worktreePath,
        worktreePath: state.worktree.record.worktreePath,
        expectedRepositoryRoot: state.worktree.record.repositoryRoot,
        expectedBranch: state.worktree.record.branch,
        expectedHead:
          state.worktree.record.headCommit ?? state.worktree.record.baseHead,
        allowRequestedCheckout: true,
        signal,
      });
    }

    // Apply a route override before a snapshot switch so every operation
    // after the session mapping is best-effort cleanup only.
    if (plan.resumed && plan.routeOverride && plan.routing) {
      routeRollback = { routing: plan.resumed.routing };
      session = persistSessionRoute(plan.resumed, plan.routing);
    }

    if (plan.resumed && state.refreshSource && plan.refresh) {
      const prepared = await prepareWorktree({
        cwd: state.cwd,
        name: plan.name,
        base: plan.refresh,
        parentSessionId,
        signal,
      });
      if (!prepared.worktree)
        throw new Error(
          prepared.fallbackReason ??
            'Worktree refresh setup failed before launch.',
        );
      // Retain the prepared resource before attaching its session. If that
      // write fails, catch cleanup removes this replacement without touching
      // the old snapshot or its session mapping.
      replacement = prepared.worktree;
      replacement = attachWorktreeSession(replacement, plan.resumed.token);
      const refreshedCwd = path.join(
        replacement.record.worktreePath,
        replacement.record.workingDirectory,
      );
      const refreshedSession = updateDelegateSessionWorktree(
        plan.resumed.token,
        replacement.record.id,
        refreshedCwd,
      );
      if (!refreshedSession)
        throw new Error('The delegate session disappeared during refresh.');
      session = refreshedSession;
      // From this point the continuation token names the replacement. Mark it
      // authoritative before any later record write can fail so catch cleanup
      // never deletes the worktree that durable session metadata now names.
      replacementSessionMapped = true;
      state.worktree = replacement;
      state.cwd = refreshedCwd;
      // If superseded cleanup later fails, retain the old snapshot's touch for
      // this successful refresh.
      touchWorktreeParentSession(state.refreshSource, parentSessionId);
      state.snapshotNotice = `Workspace snapshot changed from ${state.refreshSource.headCommit?.slice(0, 12) ?? state.refreshSource.baseHead.slice(0, 12)} to ${replacement.record.carryCommit?.slice(0, 12) ?? replacement.record.baseHead.slice(0, 12)} (${plan.refresh}). Re-read relevant files: prior source observations may be stale.`;
    } else if (plan.resumed && state.worktree?.record.snapshot) {
      state.worktree = await rehydrateWorktreeSession(
        state.worktree.record,
        plan.resumed.token,
        signal,
      );
      state.cwd = path.join(
        state.worktree.record.worktreePath,
        state.worktree.record.workingDirectory,
      );
    }

    if (plan.resumed) {
      session ??= plan.resumed;
      if (state.refreshSource) {
        try {
          await removeWorktree(state.refreshSource.id, { deleteBranch: true });
        } catch (cleanupError) {
          state.warnings.push(
            `Could not clean superseded read-only snapshot ${state.refreshSource.id}; it was retained for retry: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
    } else {
      session = createDelegateSession({
        cwd: state.cwd,
        name: plan.name,
        snapshotJsonl: plan.snapshotJsonl,
        parentSessionId,
        worktreeId: state.worktree?.record.id,
        allowWrites: state.allowWrites,
        isolation: state.isolation,
        scope: state.scope,
        routing: plan.routing,
      });
      if (state.worktree)
        state.worktree = attachWorktreeSession(state.worktree, session.token);
    }

    // Continuation membership is recorded only after all preparation and
    // session mapping steps above have succeeded. Fresh records already have
    // their immutable creatorSessionId from prepareWorktree.
    if (plan.resumed && state.worktree)
      touchWorktreeParentSession(state.worktree.record, parentSessionId);

    return {
      ...state,
      runId: createOpaqueId(),
      plan,
      session,
      ...(routeRollback ? { routeRollback } : {}),
    };
  } catch (error) {
    const cleanupWarnings: string[] = [];
    if (!plan.resumed && session) {
      const warning = removeSessionSafely(session);
      if (warning) cleanupWarnings.push(warning);
    }
    if (plan.resumed && routeRollback && !replacementSessionMapped) {
      try {
        updateDelegateSessionRouting(plan.resumed.token, routeRollback.routing);
      } catch (rollbackError) {
        cleanupWarnings.push(
          `Delegate route rollback failed for ${plan.resumed.token}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (replacement && !replacementSessionMapped) {
      const cleanup = await discardFreshWorktree(replacement.record.id);
      if (cleanup.warning) cleanupWarnings.push(cleanup.warning);
    } else if (state.worktree && !plan.resumed) {
      const cleanup = await discardFreshWorktree(state.worktree.record.id);
      if (cleanup.warning) cleanupWarnings.push(cleanup.warning);
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
    );
  }
}

export async function cleanupFreshPreparedTask(
  prepared: PreparedDelegateTask,
): Promise<{ warnings: string[] }> {
  if (prepared.setupFailure || prepared.plan.resumed || !prepared.worktree)
    return { warnings: [] };
  const warnings: string[] = [];
  const sessionWarning = removeSessionSafely(prepared.session);
  if (sessionWarning) warnings.push(sessionWarning);
  const cleanup = await discardFreshWorktree(prepared.worktree.record.id);
  if (cleanup.warning) warnings.push(cleanup.warning);
  return { warnings };
}

export async function rollbackPreparedDelegateTasks(
  prepared: PreparedDelegateTask[],
): Promise<string[]> {
  const warnings: string[] = [];
  for (const task of prepared) {
    if (task.plan.resumed) continue;
    const warning = removeSessionSafely(task.session);
    if (warning) warnings.push(warning);
  }
  for (const task of [...prepared].reverse()) {
    if (!task.plan.resumed || !task.routeRollback) continue;
    try {
      updateDelegateSessionRouting(
        task.session.token,
        task.routeRollback.routing,
      );
    } catch (error) {
      warnings.push(
        `Delegate route rollback failed for ${task.session.token}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const task of prepared) {
    if (!task.worktree || task.plan.resumed) continue;
    const cleanup = await discardFreshWorktree(task.worktree.record.id);
    if (cleanup.warning) warnings.push(cleanup.warning);
  }
  return warnings;
}

export async function runPreparedDelegateTask(
  prepared: PreparedDelegateTask,
  options: Pick<
    RunDelegateOptions,
    | 'timeoutMs'
    | 'maxConcurrency'
    | 'signal'
    | 'ownerSessionId'
    | 'onUpdate'
    | 'onRunUpdate'
    | 'mode'
    | 'hosted'
    | 'detachSignal'
  > & {
    control?: RunDelegateOptions['control'];
    onWorktreeRunning?: (worktree: PreparedWorktree) => void;
  },
): Promise<DelegatedRun> {
  if (prepared.setupFailure)
    throw new Error(
      prepared.setupFailure instanceof Error
        ? prepared.setupFailure.message
        : String(prepared.setupFailure),
    );
  if (prepared.worktree) options.onWorktreeRunning?.(prepared.worktree);
  const run = await runDelegate({
    runId: prepared.runId,
    sessionId: prepared.session.sessionId,
    lineageId: prepared.session.lineageId,
    cwd: prepared.cwd,
    name: prepared.plan.name,
    task: prepared.plan.task,
    context: prepared.plan.context,
    sessionPath: prepared.session.filePath,
    ownerSessionId: options.ownerSessionId,
    continuation: prepared.session.token,
    resuming: Boolean(prepared.plan.resumed),
    contextNote: [prepared.plan.contextNote, prepared.snapshotNotice]
      .filter((item): item is string => Boolean(item?.trim()))
      .join('\n\n'),
    handoffText: prepared.plan.handoffText,
    scope: prepared.scope,
    routing: prepared.plan.routing,
    writeRequested: prepared.plan.writeRequested,
    allowWrites: prepared.allowWrites,
    isolation: prepared.isolation,
    worktree: prepared.worktree,
    timeoutMs: options.timeoutMs,
    maxConcurrency: options.maxConcurrency,
    signal: options.signal,
    detachSignal: options.detachSignal,
    hosted: options.hosted,
    control: options.control,
    onUpdate: options.onUpdate,
    onRunUpdate: options.onRunUpdate,
    mode: options.mode,
  });
  run.warnings = [...(run.warnings ?? []), ...prepared.warnings];
  return run;
}
