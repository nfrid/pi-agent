import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { type DelegateConfig, resolveDelegateRoute } from './config';
import { loadIsolation, type PreparedIsolation } from './isolation';
import { mapWithConcurrency } from './runner';
import { resolveDelegateSession } from './session';
import {
  assertDistinctContinuationTokens,
  delegateToolResult,
  failedLifecycleRun,
  finalizeIsolatedRun,
  invalidParams,
  isolationDetails,
  makeDetails,
  markLifecycleFailure,
  mergeDelegateRouteRequest,
  writeWarnings,
} from './supervision';
import {
  cleanupFreshPreparedTask,
  type ContinuationPreflight,
  type DelegateTaskPlan,
  type PreparedDelegateTask,
  preflightDelegateContinuation,
  prepareDelegateTask,
  rollbackPreparedDelegateTasks,
  runPreparedDelegateTask,
} from './task-lifecycle';
import { createRun, type DelegatedRun } from './types';

type DelegateParams = {
  task?: string;
  tasks?: Array<{
    task: string;
    cwd?: string;
    route?: string;
    context?: 'branch' | 'fresh';
    contextNote?: string;
    scope?: string[];
    continuation?: string;
    allowWrites?: boolean;
    dependencies?: 'auto' | 'link' | 'isolated';
  }>;
  cwd?: string;
  route?: string;
  context?: 'branch' | 'fresh';
  contextNote?: string;
  scope?: string[];
  continuation?: string;
  allowWrites?: boolean;
  dependencies?: 'auto' | 'link' | 'isolated';
};

type SnapshotLookup = (cwd: string) => string | null;

type RunContext = {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: DelegateConfig;
  signal?: AbortSignal;
  getSnapshot: SnapshotLookup;
};

type RunHooks = {
  onUpdate?: (
    partial: Parameters<
      NonNullable<Parameters<typeof runPreparedDelegateTask>[1]['onUpdate']>
    >[0],
  ) => void;
  onIsolationRunning?: (isolation: PreparedIsolation) => void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function continuationOnFailure(
  prepared: PreparedDelegateTask,
  markedRunning: boolean,
  parallel: boolean,
): { continuation?: string } {
  if (parallel) {
    if (!prepared.isolation || prepared.plan.resumed || markedRunning)
      return { continuation: prepared.session.token };
    return {};
  }
  if (prepared.plan.resumed) return { continuation: prepared.session.token };
  return {};
}

async function cleanupFailedLaunch(
  prepared: PreparedDelegateTask,
  markedRunning: boolean,
): Promise<{
  warnings: string[];
  isolation?: ReturnType<typeof isolationDetails>;
}> {
  if (!prepared.isolation || markedRunning) return { warnings: [] };
  if (!prepared.plan.resumed) return cleanupFreshPreparedTask(prepared);
  return {
    warnings: [],
    isolation: isolationDetails(
      loadIsolation(prepared.isolation.record.id) ?? prepared.isolation.record,
    ),
  };
}

async function runPreparedWithLifecycle(
  runCtx: RunContext,
  prepared: PreparedDelegateTask,
  mode: 'single' | 'parallel',
  hooks: RunHooks = {},
): Promise<DelegatedRun> {
  const { pi, ctx, config, signal } = runCtx;
  const parallel = mode === 'parallel';
  let markedRunning = false;
  let run: DelegatedRun;
  try {
    run = await runPreparedDelegateTask(prepared, {
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.maxConcurrency,
      signal,
      onUpdate: hooks.onUpdate,
      mode,
      onIsolationRunning: (isolation) => {
        markedRunning = true;
        hooks.onIsolationRunning?.(isolation);
      },
    });
  } catch (error) {
    if (!parallel && (!prepared.isolation || markedRunning)) throw error;
    const cleanup = await cleanupFailedLaunch(prepared, markedRunning);
    const failed = failedLifecycleRun(
      prepared.plan.task,
      prepared.plan.routing,
      {
        cwd: prepared.cwd,
        context: prepared.plan.context,
        contextNote: prepared.plan.contextNote,
        scope: prepared.scope,
        writeRequested: prepared.plan.writeRequested,
        allowWrites: prepared.allowWrites,
        ...continuationOnFailure(prepared, markedRunning, parallel),
        warnings: [...prepared.warnings, ...cleanup.warnings],
      },
      error,
    );
    if (prepared.isolation && markedRunning)
      await markLifecycleFailure(failed, prepared.isolation, error);
    else failed.isolation = cleanup.isolation;
    return failed;
  }

  try {
    await finalizeIsolatedRun(pi, ctx, run, prepared.isolation);
  } catch (error) {
    if (prepared.isolation)
      await markLifecycleFailure(run, prepared.isolation, error);
    else throw error;
  }
  return run;
}

async function preparePlans(
  plans: DelegateTaskPlan[],
  parallel: boolean,
  preflights: ContinuationPreflight[],
): Promise<PreparedDelegateTask[]> {
  const prepared: PreparedDelegateTask[] = [];
  try {
    for (let index = 0; index < plans.length; index++)
      prepared.push(await prepareDelegateTask(plans[index], preflights[index]));
    return prepared;
  } catch (error) {
    const cleanupWarnings = await rollbackPreparedDelegateTasks(prepared);
    const prefix = parallel
      ? 'Parallel delegate setup failed before launch'
      : 'Delegate setup failed before launch';
    return invalidParams(
      `${prefix}: ${errorText(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
    );
  }
}

export async function executeSingleDelegate(
  runCtx: RunContext,
  params: DelegateParams,
  hooks: RunHooks,
) {
  const { ctx, config, getSnapshot } = runCtx;
  if (
    params.continuation &&
    (params.cwd !== undefined ||
      params.context !== undefined ||
      params.scope !== undefined ||
      params.dependencies !== undefined)
  )
    return invalidParams(
      'A continuation reuses its original cwd, context, scope, and dependency mode; do not provide replacements.',
    );
  const resumed = params.continuation
    ? resolveDelegateSession(params.continuation)
    : undefined;
  if (params.continuation && !resumed)
    return invalidParams('Unknown or expired delegate continuation token.');
  const resolvedRoute = resolveDelegateRoute(
    mergeDelegateRouteRequest(params.route, resumed?.routing),
    config,
  );
  if (resolvedRoute.error) return invalidParams(resolvedRoute.error);
  const requestedCwd = resumed?.cwd ?? params.cwd ?? ctx.cwd;
  const context = resumed ? 'continuation' : (params.context ?? 'fresh');
  const snapshot =
    !resumed && context === 'branch' ? getSnapshot(requestedCwd) : undefined;
  if (!resumed && context === 'branch' && !snapshot)
    return invalidParams(
      'Cannot delegate: failed to snapshot current session branch.',
    );

  const task = params.task?.trim();
  if (!task) return invalidParams('Delegate task is required.');

  const plan: DelegateTaskPlan = {
    task,
    requestedCwd,
    context,
    contextNote: params.contextNote,
    scope: params.scope,
    dependencyMode: params.dependencies,
    writeRequested: params.allowWrites ?? false,
    routing: resolvedRoute.routing,
    resumed: resumed ?? undefined,
    routeOverride: Boolean(resumed && params.route !== undefined),
    snapshotJsonl: snapshot ?? undefined,
    warnings: [],
  };
  let preflight: ContinuationPreflight;
  try {
    preflight = preflightDelegateContinuation(plan);
  } catch (error) {
    return invalidParams(errorText(error));
  }
  const prepared = await preparePlans([plan], false, [preflight]);
  const run = await runPreparedWithLifecycle(
    runCtx,
    prepared[0],
    'single',
    hooks,
  );
  return delegateToolResult(runCtx.pi, runCtx.ctx, 'single', [run]);
}

export async function executeParallelDelegate(
  runCtx: RunContext,
  params: DelegateParams,
  hooks: RunHooks,
) {
  const { ctx, config, getSnapshot } = runCtx;
  const tasks = (params.tasks ?? [])
    .map((item) => ({ ...item, task: item.task.trim() }))
    .filter((item) => item.task);
  if (!tasks.length)
    return invalidParams('Parallel delegation requires a non-empty task.');
  if (tasks.length > config.maxParallelTasks)
    return invalidParams(
      `Too many delegated tasks (${tasks.length}). Maximum is ${config.maxParallelTasks}.`,
    );
  if (params.continuation)
    return invalidParams(
      'For parallel delegation, set continuation on each task rather than as a shared default.',
    );

  const resumed = tasks.map((item) => {
    if (
      item.continuation &&
      (item.cwd !== undefined ||
        item.context !== undefined ||
        item.scope !== undefined ||
        item.dependencies !== undefined)
    )
      return invalidParams(
        'A continuation task cannot replace cwd, context, scope, or dependency mode.',
      );
    const session = item.continuation
      ? resolveDelegateSession(item.continuation)
      : undefined;
    if (item.continuation && !session)
      return invalidParams('Unknown or expired delegate continuation token.');
    return session ?? undefined;
  });
  assertDistinctContinuationTokens(resumed.map((session) => session?.token));
  if (
    resumed.some(Boolean) &&
    (params.cwd !== undefined ||
      params.context !== undefined ||
      params.scope !== undefined ||
      params.dependencies !== undefined)
  )
    return invalidParams(
      'Parallel continuations reuse their original cwd, history, scope, and dependency mode; do not provide top-level replacements.',
    );

  const routings = tasks.map((item, index) =>
    resolveDelegateRoute(
      mergeDelegateRouteRequest(
        item.route ?? params.route,
        resumed[index]?.routing,
      ),
      config,
    ),
  );
  const routingError = routings.find((item) => item.error)?.error;
  if (routingError) return invalidParams(routingError);

  const contexts = tasks.map((item, index) =>
    resumed[index]
      ? ('continuation' as const)
      : (item.context ?? params.context ?? 'fresh'),
  );
  const requestedCwds = tasks.map(
    (item, index) => resumed[index]?.cwd ?? item.cwd ?? params.cwd ?? ctx.cwd,
  );
  const scopes = tasks.map((item) => item.scope ?? params.scope);
  const writeRequests = tasks.map(
    (item) => item.allowWrites ?? params.allowWrites ?? false,
  );
  const warnings = writeWarnings(requestedCwds, writeRequests, scopes);
  for (let index = 0; index < tasks.length; index++) {
    if (
      !resumed[index] &&
      contexts[index] === 'branch' &&
      !getSnapshot(requestedCwds[index])
    )
      return invalidParams(
        'Cannot delegate: failed to snapshot current session branch.',
      );
  }

  const plans: DelegateTaskPlan[] = tasks.map((item, index) => ({
    task: item.task,
    requestedCwd: requestedCwds[index],
    context: contexts[index],
    contextNote: item.contextNote ?? params.contextNote,
    scope: scopes[index],
    dependencyMode: item.dependencies ?? params.dependencies,
    writeRequested: writeRequests[index],
    routing: routings[index].routing,
    resumed: resumed[index],
    routeOverride: Boolean(
      resumed[index] && (item.route ?? params.route) !== undefined,
    ),
    snapshotJsonl:
      contexts[index] === 'branch'
        ? (getSnapshot(requestedCwds[index]) ?? undefined)
        : undefined,
    warnings: warnings[index],
  }));

  let preflights: ContinuationPreflight[];
  try {
    preflights = plans.map((plan) => preflightDelegateContinuation(plan));
  } catch (error) {
    return invalidParams(errorText(error));
  }

  const prepared = await preparePlans(plans, true, preflights);
  const liveRuns = prepared.map((item) =>
    createRun(item.plan.task, item.plan.routing, {
      cwd: item.cwd,
      context: item.plan.context,
      contextNote: item.plan.contextNote,
      scope: item.scope,
      writeRequested: item.plan.writeRequested,
      allowWrites: item.allowWrites,
      continuation: item.session.token,
      warnings: item.warnings,
    }),
  );
  const warningText = [...new Set(prepared.flatMap((item) => item.warnings))];
  const emit = () => {
    const done = liveRuns.filter((run) => run.exitCode !== -1).length;
    hooks.onUpdate?.({
      content: [
        {
          type: 'text',
          text: `${warningText.length ? `${warningText.map((warning) => `Warning: ${warning}`).join('\n')}\n\n` : ''}Delegated tasks: ${done}/${liveRuns.length} complete`,
        },
      ],
      details: makeDetails('parallel', [...liveRuns]),
    });
  };
  emit();

  const launchedFreshIsolationIds = new Set<string>();
  let runs: DelegatedRun[];
  try {
    runs = await mapWithConcurrency(
      prepared,
      config.maxConcurrency,
      async (item, index) => {
        const run = await runPreparedWithLifecycle(runCtx, item, 'parallel', {
          onUpdate: (partial) => {
            const current = partial.details?.runs?.[0];
            if (current)
              liveRuns[index] = { ...current, warnings: item.warnings };
            emit();
          },
          onIsolationRunning: (isolation) => {
            if (!item.plan.resumed)
              launchedFreshIsolationIds.add(isolation.record.id);
          },
        });
        liveRuns[index] = run;
        emit();
        return run;
      },
    );
  } catch (error) {
    const cleanupWarnings: string[] = [];
    for (const item of prepared) {
      if (
        !item.isolation ||
        item.plan.resumed ||
        launchedFreshIsolationIds.has(item.isolation.record.id)
      )
        continue;
      const cleanup = await cleanupFreshPreparedTask(item);
      cleanupWarnings.push(...cleanup.warnings);
    }
    throw new Error(
      `${errorText(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
    );
  }
  return delegateToolResult(runCtx.pi, runCtx.ctx, 'parallel', runs);
}
