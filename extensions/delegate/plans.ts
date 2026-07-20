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
  task: string;
  cwd?: string;
  route?: string;
  context?: 'branch' | 'fresh';
  contextNote?: string;
  scope?: string[];
  continuation?: string;
  allowWrites?: boolean;
  dependencies?: DelegateTaskPlan['dependencyMode'];
}

interface SharedDefaults {
  cwd?: string;
  route?: string;
  context?: 'branch' | 'fresh';
  contextNote?: string;
  scope?: string[];
  allowWrites?: boolean;
  dependencies?: DelegateTaskPlan['dependencyMode'];
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
    dependencies?: unknown;
  },
  message: string,
): void {
  if (
    continuation &&
    (fields.cwd !== undefined ||
      fields.context !== undefined ||
      fields.scope !== undefined ||
      fields.dependencies !== undefined)
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
      .map((item) => ({ ...item, task: item.task.trim() }))
      .filter((item) => item.task);
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
        dependencies: params.dependencies,
      },
    };
  }

  const task = params.task?.trim();
  if (!task) invalidParams('Delegate task is required.');
  return {
    parallel: false,
    inputs: [
      {
        task,
        cwd: params.cwd,
        route: params.route,
        context: params.context,
        contextNote: params.contextNote,
        scope: params.scope,
        continuation: params.continuation,
        allowWrites: params.allowWrites,
        dependencies: params.dependencies,
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
        ? 'A continuation task cannot replace cwd, context, scope, or dependency mode.'
        : 'A continuation reuses its original cwd, context, scope, and dependency mode; do not provide replacements.',
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
      shared.dependencies !== undefined)
  )
    invalidParams(
      'Parallel continuations reuse their original cwd, history, scope, and dependency mode; do not provide top-level replacements.',
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
  const writeRequests = inputs.map(
    (item) => item.allowWrites ?? shared.allowWrites ?? false,
  );
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

  const plans: DelegateTaskPlan[] = inputs.map((item, index) => ({
    task: item.task,
    requestedCwd: requestedCwds[index],
    context: contexts[index],
    contextNote: item.contextNote ?? shared.contextNote,
    scope: scopes[index],
    dependencyMode: item.dependencies ?? shared.dependencies,
    writeRequested: writeRequests[index],
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
