import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type DelegateConfig, resolveDelegateRoute } from './config';
import {
  assertDistinctContinuationTokens,
  invalidParams,
} from './param-errors';
import { mergeDelegateRouteRequest, writeWarnings } from './routing-warnings';
import { resolveDelegateSession } from './session';
import {
  type ContinuationPreflight,
  type DelegateTaskPlan,
  preflightDelegateContinuation,
} from './task-lifecycle';
import type { DelegateParams } from './tool';

type SnapshotLookup = (cwd: string) => string | null;

interface TaskInput {
  name: string;
  task: string;
  cwd?: string;
  route?: string;
  context?: 'branch' | 'fresh';
  contextNote?: string;
  scope?: string[];
  continuation?: string;
  allowWrites?: boolean;
  isolation?: DelegateTaskPlan['isolation'];
  from?: DelegateTaskPlan['base'];
  refresh?: DelegateTaskPlan['refresh'];
}

interface SharedDefaults {
  cwd?: string;
  route?: string;
  context?: 'branch' | 'fresh';
  contextNote?: string;
  scope?: string[];
  allowWrites?: boolean;
  isolation?: DelegateTaskPlan['isolation'];
  from?: DelegateTaskPlan['base'];
  refresh?: DelegateTaskPlan['refresh'];
}

export interface BuiltDelegatePlans {
  parallel: boolean;
  plans: DelegateTaskPlan[];
  preflights: ContinuationPreflight[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertContinuationFields(
  continuation: string | undefined,
  fields: {
    cwd?: unknown;
    context?: unknown;
    scope?: unknown;
    from?: unknown;
  },
  message: string,
): void {
  if (
    continuation &&
    (fields.cwd !== undefined ||
      fields.context !== undefined ||
      fields.scope !== undefined ||
      fields.from !== undefined)
  )
    invalidParams(message);
}

function normalizeInputs(params: DelegateParams): {
  parallel: boolean;
  inputs: TaskInput[];
  shared: SharedDefaults;
} {
  const parallel = Array.isArray(params.tasks) && params.tasks.length > 0;
  if (parallel) {
    const inputs = (params.tasks ?? [])
      .map((item) => ({
        ...item,
        name: item.name?.trim(),
        task: item.task.trim(),
      }))
      .filter((item) => item.task);
    if (inputs.some((item) => !item.name))
      invalidParams('Every delegated task requires a subagent name.');
    if (!inputs.length)
      invalidParams('Parallel delegation requires a non-empty task.');
    return {
      parallel: true,
      inputs,
      shared: {
        cwd: params.cwd,
        route: params.route,
        context: params.context,
        contextNote: params.contextNote,
        scope: params.scope,
        allowWrites: params.allowWrites,
        isolation: params.isolation,
        from: params.from,
        refresh: params.refresh,
      },
    };
  }

  const task = params.task?.trim();
  if (!task) invalidParams('Delegate task is required.');
  const name = params.name?.trim();
  if (!name) invalidParams('Delegate name is required with task.');
  return {
    parallel: false,
    inputs: [
      {
        name,
        task,
        cwd: params.cwd,
        route: params.route,
        context: params.context,
        contextNote: params.contextNote,
        scope: params.scope,
        continuation: params.continuation,
        allowWrites: params.allowWrites,
        isolation: params.isolation,
        from: params.from,
        refresh: params.refresh,
      },
    ],
    shared: {},
  };
}

export function buildDelegatePlans(
  params: DelegateParams,
  ctx: ExtensionContext,
  config: DelegateConfig,
  getSnapshot: SnapshotLookup,
): BuiltDelegatePlans {
  const { parallel, inputs, shared } = normalizeInputs(params);

  if (parallel) {
    if (params.continuation)
      invalidParams(
        'For parallel delegation, set continuation on each task rather than as a shared default.',
      );
    if (inputs.length > config.maxParallelTasks)
      invalidParams(
        `Too many delegated tasks (${inputs.length}). Maximum is ${config.maxParallelTasks}.`,
      );
  }

  const resumed = inputs.map((item) => {
    assertContinuationFields(
      item.continuation,
      item,
      parallel
        ? 'A continuation task cannot replace cwd, context, scope, or base.'
        : 'A continuation reuses its original cwd, context, scope, and base; do not provide replacements.',
    );
    const session = item.continuation
      ? resolveDelegateSession(item.continuation)
      : undefined;
    if (item.continuation && !session)
      invalidParams('Unknown or expired delegate continuation token.');
    return session;
  });
  assertDistinctContinuationTokens(resumed.map((session) => session?.token));

  if (
    parallel &&
    resumed.some(Boolean) &&
    (shared.cwd !== undefined ||
      shared.context !== undefined ||
      shared.scope !== undefined ||
      shared.from !== undefined ||
      shared.refresh !== undefined)
  )
    invalidParams(
      'Parallel continuations reuse their original cwd, history, scope, and base; do not provide top-level replacements.',
    );

  const routings = inputs.map((item, index) =>
    resolveDelegateRoute(
      mergeDelegateRouteRequest(
        item.route ?? shared.route,
        resumed[index]?.routing,
      ),
      config,
    ),
  );
  const routingError = routings.find((item) => item.error)?.error;
  if (routingError) invalidParams(routingError);

  const contexts = inputs.map((item, index) =>
    resumed[index]
      ? ('continuation' as const)
      : (item.context ?? shared.context ?? 'fresh'),
  );
  const requestedCwds = inputs.map(
    (item, index) => resumed[index]?.cwd ?? item.cwd ?? shared.cwd ?? ctx.cwd,
  );
  const scopes = inputs.map((item) => item.scope ?? shared.scope);
  const writeRequestExplicit = inputs.map(
    (item) =>
      item.allowWrites !== undefined || shared.allowWrites !== undefined,
  );
  const writeRequests = inputs.map((item, index) => {
    const requested = item.allowWrites ?? shared.allowWrites;
    if (requested !== undefined) return requested;
    // Continuations preserve their original capability. Sessions written
    // before capability persistence infer writable from their worktree.
    return resumed[index]?.allowWrites ?? Boolean(resumed[index]?.worktreeId);
  });
  const isolationExplicit = inputs.map(
    (item) => item.isolation !== undefined || shared.isolation !== undefined,
  );
  const isolations = inputs.map((item, index) => {
    const requested = item.isolation ?? shared.isolation;
    if (requested !== undefined) return requested;
    if (resumed[index]) return resumed[index].isolation;
    return writeRequests[index] ? 'worktree' : 'shared';
  });
  for (let index = 0; index < inputs.length; index++) {
    // A migrated writable session with no worktree is a direct-parent-write
    // legacy record. Reject inherited or unchanged restated values. Only an
    // actual requested change reaches continuation preflight for its precise
    // immutable-field error.
    const inheritedWritable =
      resumed[index]?.allowWrites ?? Boolean(resumed[index]?.worktreeId);
    const changesInheritedMode =
      Boolean(resumed[index]) &&
      ((writeRequestExplicit[index] &&
        writeRequests[index] !== inheritedWritable) ||
        (isolationExplicit[index] &&
          isolations[index] !== resumed[index]?.isolation));
    const inheritedWritableShared =
      Boolean(resumed[index]) &&
      inheritedWritable &&
      resumed[index]?.isolation === 'shared' &&
      !changesInheritedMode;
    if (
      (!resumed[index] &&
        writeRequests[index] &&
        isolations[index] === 'shared') ||
      inheritedWritableShared
    )
      invalidParams(
        'Writable delegates require worktree isolation; shared writable delegates are not supported.',
      );
    if (
      !resumed[index] &&
      (inputs[index].from !== undefined || shared.from !== undefined) &&
      isolations[index] === 'shared'
    )
      invalidParams(
        'from requires worktree isolation; it cannot be used with a shared delegate.',
      );
  }
  const warnings = parallel
    ? writeWarnings(requestedCwds, writeRequests, scopes)
    : inputs.map(() => [] as string[]);

  for (let index = 0; index < inputs.length; index++) {
    if (
      !resumed[index] &&
      contexts[index] === 'branch' &&
      !getSnapshot(requestedCwds[index])
    )
      invalidParams(
        'Cannot delegate: failed to snapshot current session branch.',
      );
  }

  for (let index = 0; index < inputs.length; index++) {
    if ((inputs[index].refresh ?? shared.refresh) && !resumed[index])
      invalidParams(
        'refresh is only available on a read-only worktree continuation.',
      );
  }

  const plans: DelegateTaskPlan[] = inputs.map((item, index) => ({
    name: item.name,
    task: item.task,
    requestedCwd: requestedCwds[index],
    context: contexts[index],
    contextNote: item.contextNote ?? shared.contextNote,
    scope: scopes[index],
    base: item.from ?? shared.from,
    refresh: item.refresh ?? shared.refresh,
    writeRequested: writeRequests[index],
    isolation: isolations[index],
    allowWritesExplicit: writeRequestExplicit[index],
    isolationExplicit: isolationExplicit[index],
    routing: routings[index].routing,
    resumed: resumed[index] ?? undefined,
    routeOverride: Boolean(
      resumed[index] && (item.route ?? shared.route) !== undefined,
    ),
    snapshotJsonl:
      contexts[index] === 'branch'
        ? (getSnapshot(requestedCwds[index]) ?? undefined)
        : undefined,
    warnings: parallel ? warnings[index] : [],
  }));

  let preflights: ContinuationPreflight[];
  try {
    preflights = plans.map((plan) => preflightDelegateContinuation(plan));
  } catch (error) {
    invalidParams(errorText(error));
  }

  return { parallel, plans, preflights };
}
