import * as path from 'node:path';
import {
  attachIsolationSession,
  type DependencyMode,
  loadIsolation,
  markIsolationRunning,
  type PreparedIsolation,
  prepareWritableIsolation,
  restoreIsolationSession,
} from './isolation';
import { type RunDelegateOptions, runDelegate } from './runner';
import {
  createDelegateSession,
  type DelegateSession,
  updateDelegateSessionRouting,
} from './session';
import {
  discardFreshIsolation,
  persistSessionRoute,
  removeSessionSafely,
} from './supervision';
import type {
  DelegateContext,
  DelegatedRun,
  DelegateIsolationState,
  DelegateRouteState,
} from './types';

export interface DelegateTaskPlan {
  task: string;
  requestedCwd: string;
  context: DelegateContext;
  contextNote?: string;
  scope?: string[];
  dependencyMode?: DependencyMode;
  writeRequested: boolean;
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
  isolation?: PreparedIsolation;
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
    allowWrites: false,
    warnings: [...plan.warnings],
  };
  if (plan.resumed?.isolationId) {
    const record = loadIsolation(plan.resumed.isolationId);
    if (!record)
      throw new Error(
        'The isolated worktree for this continuation is unavailable.',
      );
    state.isolation = restoreIsolationSession(
      record,
      plan.resumed.token,
      plan.resumed.filePath,
    );
    state.cwd = path.join(record.worktreePath, record.workingDirectory);
    state.scope = record.requestedScopes;
    state.allowWrites = plan.writeRequested;
  } else if (plan.writeRequested && plan.resumed) {
    state.warnings.push(
      'This continuation was created read-only and cannot be elevated; running read-only.',
    );
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
    if (plan.writeRequested && !plan.resumed) {
      const prepared = await prepareWritableIsolation({
        cwd: plan.requestedCwd,
        scopes: state.scope ?? [],
        dependencyMode: plan.dependencyMode,
      });
      if (prepared.isolation) {
        state.isolation = prepared.isolation;
        state.cwd = path.join(
          prepared.isolation.record.worktreePath,
          prepared.isolation.record.workingDirectory,
        );
        state.allowWrites = true;
      } else if (prepared.fallbackReason) {
        state.warnings.push(prepared.fallbackReason);
      }
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
        isolationId: state.isolation?.record.id,
        routing: plan.routing,
      });
      if (state.isolation)
        state.isolation = attachIsolationSession(
          state.isolation,
          session.token,
          session.filePath,
        );
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
    if (state.isolation && !plan.resumed) {
      const cleanup = await discardFreshIsolation(state.isolation);
      if (cleanup.warning) cleanupWarnings.push(cleanup.warning);
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
    );
  }
}

export async function cleanupFreshPreparedTask(
  prepared: PreparedDelegateTask,
): Promise<{
  warnings: string[];
  isolation?: DelegateIsolationState;
}> {
  if (prepared.plan.resumed || !prepared.isolation) return { warnings: [] };
  const warnings: string[] = [];
  const sessionWarning = removeSessionSafely(prepared.session);
  if (sessionWarning) warnings.push(sessionWarning);
  const cleanup = await discardFreshIsolation(prepared.isolation);
  if (cleanup.warning) warnings.push(cleanup.warning);
  return { warnings, isolation: cleanup.details };
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
    if (!task.isolation || task.plan.resumed) continue;
    const cleanup = await discardFreshIsolation(task.isolation);
    if (cleanup.warning) warnings.push(cleanup.warning);
  }
  return warnings;
}

export async function runPreparedDelegateTask(
  prepared: PreparedDelegateTask,
  options: Pick<
    RunDelegateOptions,
    'timeoutMs' | 'maxConcurrency' | 'signal' | 'onUpdate' | 'makeDetails'
  > & {
    onIsolationRunning?: (isolation: PreparedIsolation) => void;
  },
): Promise<DelegatedRun> {
  if (prepared.isolation) {
    prepared.isolation = {
      ...prepared.isolation,
      record: await markIsolationRunning(prepared.isolation.record.id),
    };
    options.onIsolationRunning?.(prepared.isolation);
  }
  const run = await runDelegate({
    cwd: prepared.cwd,
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
    timeoutMs: options.timeoutMs,
    maxConcurrency: options.maxConcurrency,
    signal: options.signal,
    onUpdate: options.onUpdate,
    makeDetails: options.makeDetails,
  });
  run.warnings = [...(run.warnings ?? []), ...prepared.warnings];
  return run;
}
