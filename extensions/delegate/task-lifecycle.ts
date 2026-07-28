import * as path from 'node:path';
import { persistSessionRoute, removeSessionSafely } from './routing-warnings';
import { type RunDelegateOptions, runDelegate } from './runner';
import {
  createDelegateSession,
  type DelegateSession,
  updateDelegateSessionRouting,
} from './session';
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
  restoreWorktreeSession,
  type WorktreeBase,
} from './worktree';

export interface DelegateTaskPlan {
  name: string;
  task: string;
  requestedCwd: string;
  context: DelegateContext;
  contextNote?: string;
  scope?: string[];
  base?: WorktreeBase;
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
  warnings: string[];
}

export interface PreparedDelegateTask extends ContinuationPreflight {
  plan: DelegateTaskPlan;
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
    if (originalIsolation === 'worktree') {
      if (!plan.resumed.worktreeId)
        throw new Error('The worktree for this continuation is unavailable.');
      const record = loadWorktree(plan.resumed.worktreeId);
      if (!record)
        throw new Error('The worktree for this continuation is unavailable.');
      state.worktree = restoreWorktreeSession(record, plan.resumed.token);
      state.cwd = path.join(record.worktreePath, record.workingDirectory);
    }
  }
  return state;
}

export async function prepareDelegateTask(
  plan: DelegateTaskPlan,
  preflight = preflightDelegateContinuation(plan),
): Promise<PreparedDelegateTask> {
  const state = { ...preflight, warnings: [...preflight.warnings] };
  let session: DelegateSession | undefined;
  let routeRollback: { routing?: DelegateRouteState } | undefined;
  try {
    if (plan.isolation === 'worktree' && !plan.resumed) {
      const prepared = await prepareWorktree({
        cwd: plan.requestedCwd,
        name: plan.name,
        base: plan.base,
      });
      if (!prepared.worktree)
        throw new Error(
          prepared.fallbackReason ?? 'Worktree setup failed before launch.',
        );
      state.worktree = prepared.worktree;
      state.cwd = path.join(
        prepared.worktree.record.worktreePath,
        prepared.worktree.record.workingDirectory,
      );
    }

    if (plan.resumed) {
      if (plan.routeOverride && plan.routing) {
        routeRollback = { routing: plan.resumed.routing };
        session = persistSessionRoute(plan.resumed, plan.routing);
      } else {
        session = plan.resumed;
      }
    } else {
      session = createDelegateSession({
        cwd: state.cwd,
        snapshotJsonl: plan.snapshotJsonl,
        worktreeId: state.worktree?.record.id,
        allowWrites: state.allowWrites,
        isolation: state.isolation,
        scope: state.scope,
        routing: plan.routing,
      });
      if (state.worktree)
        state.worktree = attachWorktreeSession(state.worktree, session.token);
    }

    return {
      ...state,
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
    if (plan.resumed && routeRollback) {
      try {
        updateDelegateSessionRouting(plan.resumed.token, routeRollback.routing);
      } catch (rollbackError) {
        cleanupWarnings.push(
          `Delegate route rollback failed for ${plan.resumed.token}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (state.worktree && !plan.resumed) {
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
  if (prepared.plan.resumed || !prepared.worktree) return { warnings: [] };
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
    'timeoutMs' | 'maxConcurrency' | 'signal' | 'onUpdate' | 'mode'
  > & {
    onWorktreeRunning?: (worktree: PreparedWorktree) => void;
  },
): Promise<DelegatedRun> {
  if (prepared.worktree) options.onWorktreeRunning?.(prepared.worktree);
  const run = await runDelegate({
    cwd: prepared.cwd,
    name: prepared.plan.name,
    task: prepared.plan.task,
    context: prepared.plan.context,
    sessionPath: prepared.session.filePath,
    continuation: prepared.session.token,
    resuming: Boolean(prepared.plan.resumed),
    contextNote: prepared.plan.contextNote,
    scope: prepared.scope,
    routing: prepared.plan.routing,
    writeRequested: prepared.plan.writeRequested,
    allowWrites: prepared.allowWrites,
    isolation: prepared.isolation,
    worktree: prepared.worktree,
    timeoutMs: options.timeoutMs,
    maxConcurrency: options.maxConcurrency,
    signal: options.signal,
    onUpdate: options.onUpdate,
    mode: options.mode,
  });
  run.warnings = [...(run.warnings ?? []), ...prepared.warnings];
  return run;
}
