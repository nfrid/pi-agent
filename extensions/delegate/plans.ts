import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveArtifact } from '../shared/artifacts';
import { type DelegateConfig, resolveDelegateRoute } from './config';
import {
  assertDistinctContinuationTokens,
  invalidParams,
} from './param-errors';
import { mergeDelegateRouteRequest, writeWarnings } from './routing-warnings';
import { type DelegateSession, resolveDelegateSession } from './session';

import {
  type ContinuationPreflight,
  type DelegateTaskPlan,
  preflightDelegateContinuation,
} from './task-lifecycle';
import type {
  DelegateHandoffFrom,
  DelegateHandoffInput,
  DelegateParams,
} from './tool';
import {
  frameWorkflowEvidence,
  WORKFLOW_INPUT_CAPS,
  workflowEvidencePromptBytes,
} from './workflow-inputs';

type SnapshotLookup = (cwd: string) => string | null;

export const DELEGATE_HANDOFF_CAPS = {
  perItemMaxBytes: WORKFLOW_INPUT_CAPS.perItemMaxBytes,
  aggregateMaxBytes: WORKFLOW_INPUT_CAPS.aggregateMaxBytes,
} as const;

interface TaskInput {
  name?: string;
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
  worktreePath?: string;
  handoffFrom?: DelegateHandoffInput;
}

interface NamedTaskInput extends TaskInput {
  name: string;
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
  worktreePath?: string;
  handoffFrom?: DelegateHandoffInput;
}

interface DerivedTask {
  input: TaskInput;
  resumed?: DelegateSession;
  routing?: DelegateTaskPlan['routing'];
  routingError?: string;
  context: DelegateTaskPlan['context'];
  requestedCwd: string;
  scope?: string[];
  writeRequestExplicit: boolean;
  writeRequested: boolean;
  isolationExplicit: boolean;
  isolation: DelegateTaskPlan['isolation'];
  worktreePath?: string;
  warnings: string[];
}

type NamedDerivedTask = Omit<DerivedTask, 'input'> & {
  input: NamedTaskInput;
};

export interface BuiltDelegateTask {
  plan: DelegateTaskPlan;
  preflight: ContinuationPreflight;
}

export interface BuiltDelegatePlans {
  parallel: boolean;
  tasks: BuiltDelegateTask[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeHandoffFrom(
  input: DelegateHandoffInput | undefined,
): DelegateHandoffFrom[] | undefined {
  if (!input) return undefined;
  return Array.isArray(input) ? input : [input];
}

function assertContinuationFields(
  continuation: string | undefined,
  fields: {
    cwd?: unknown;
    context?: unknown;
    scope?: unknown;
    from?: unknown;
    worktreePath?: unknown;
  },
  message: string,
): void {
  if (
    continuation &&
    (fields.cwd !== undefined ||
      fields.context !== undefined ||
      fields.scope !== undefined ||
      fields.from !== undefined ||
      fields.worktreePath !== undefined)
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
    const shared: SharedDefaults = {
      cwd: params.cwd,
      route: params.route,
      context: params.context,
      contextNote: params.contextNote,
      scope: params.scope,
      allowWrites: params.allowWrites,
      isolation: params.isolation,
      from: params.from,
      refresh: params.refresh,
      worktreePath: params.worktreePath,
      handoffFrom: params.handoffFrom,
    };
    const inputs = (params.tasks ?? [])
      .map((item) => ({
        ...item,
        name: item.name?.trim(),
        task: item.task.trim(),
      }))
      .filter((item) => item.task);
    if (!inputs.length)
      invalidParams('Parallel delegation requires a non-empty task.');
    return { parallel: true, inputs, shared };
  }

  const task = params.task?.trim();
  if (!task) invalidParams('Delegate task is required.');
  return {
    parallel: false,
    inputs: [
      {
        name: params.name?.trim(),
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
        worktreePath: params.worktreePath,
        handoffFrom: params.handoffFrom,
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
  const { parallel, inputs: unnamedInputs, shared } = normalizeInputs(params);

  if (parallel) {
    if (params.continuation)
      invalidParams(
        'For parallel delegation, set continuation on each task rather than as a shared default.',
      );
    if (unnamedInputs.length > config.maxParallelTasks)
      invalidParams(
        `Too many delegated tasks (${unnamedInputs.length}). Maximum is ${config.maxParallelTasks}.`,
      );
  }

  // Every subsequent derivation operates on this task object. This keeps the
  // input, continuation, route, capability, plan, and preflight together.
  let tasks: DerivedTask[] = unnamedInputs.map((input) => ({
    input,
    context: 'fresh',
    requestedCwd: ctx.cwd,
    writeRequestExplicit: false,
    writeRequested: false,
    isolationExplicit: false,
    isolation: 'shared',
    warnings: [],
  }));

  tasks = tasks.map((task) => {
    const { input } = task;
    assertContinuationFields(
      input.continuation,
      input,
      parallel
        ? 'A continuation task cannot replace cwd, context, scope, or base.'
        : 'A continuation reuses its original cwd, context, scope, and base; do not provide replacements.',
    );
    const resumed = input.continuation
      ? resolveDelegateSession(input.continuation)
      : undefined;
    if (input.continuation && !resumed)
      invalidParams('Unknown or expired delegate continuation token.');
    return { ...task, resumed: resumed ?? undefined };
  });
  assertDistinctContinuationTokens(tasks.map((task) => task.resumed?.token));

  let namedTasks: NamedDerivedTask[] = tasks.map((task) => {
    const name = task.input.name;
    if (name) return { ...task, input: { ...task.input, name } };
    if (task.resumed?.name)
      return {
        ...task,
        input: { ...task.input, name: task.resumed.name },
      };
    if (task.resumed)
      return invalidParams(
        'This delegate continuation uses legacy metadata without a persisted display name; supply name explicitly to continue it.',
      );
    return invalidParams(
      parallel
        ? 'Every delegated task requires a subagent name.'
        : 'Delegate name is required with task.',
    );
  });

  if (
    parallel &&
    namedTasks.some((task) => task.resumed) &&
    (shared.cwd !== undefined ||
      shared.context !== undefined ||
      shared.scope !== undefined ||
      shared.from !== undefined ||
      shared.refresh !== undefined ||
      shared.worktreePath !== undefined)
  )
    invalidParams(
      'Parallel continuations reuse their original cwd, history, scope, and base; do not provide top-level replacements.',
    );

  namedTasks = namedTasks.map((task) => {
    const requestedRoute = task.input.route ?? shared.route;
    if (requestedRoute === undefined && task.resumed?.routing)
      return {
        ...task,
        routing: task.resumed.routing,
        routingError: undefined,
      };
    const result = resolveDelegateRoute(
      mergeDelegateRouteRequest(requestedRoute, task.resumed?.routing),
      config,
    );
    return {
      ...task,
      routing: result.routing,
      routingError: result.error,
    };
  });
  const routingError = namedTasks.find(
    (task) => task.routingError,
  )?.routingError;
  if (routingError) invalidParams(routingError);

  namedTasks = namedTasks.map((task) => ({
    ...task,
    context: task.resumed
      ? 'continuation'
      : (task.input.context ?? shared.context ?? 'fresh'),
    requestedCwd: task.resumed?.cwd ?? task.input.cwd ?? shared.cwd ?? ctx.cwd,
    scope: task.input.scope ?? shared.scope,
    worktreePath: task.input.worktreePath ?? shared.worktreePath,
  }));

  namedTasks = namedTasks.map((task) => {
    const writeRequestExplicit =
      task.input.allowWrites !== undefined || shared.allowWrites !== undefined;
    const requested = task.input.allowWrites ?? shared.allowWrites;
    const writeRequested =
      requested ??
      task.resumed?.allowWrites ??
      Boolean(task.resumed?.worktreeId);
    const isolationExplicit =
      task.input.isolation !== undefined || shared.isolation !== undefined;
    const worktreePath = task.worktreePath;
    const isolation =
      task.input.isolation ??
      shared.isolation ??
      (task.resumed ? task.resumed.isolation : undefined) ??
      (writeRequested || worktreePath ? 'worktree' : 'shared');
    return {
      ...task,
      writeRequestExplicit,
      writeRequested,
      isolationExplicit,
      isolation,
      worktreePath,
    };
  });

  for (const task of namedTasks) {
    // A migrated writable session with no worktree is a direct-parent-write
    // legacy record. Reject inherited or unchanged restated values. Only an
    // actual requested change reaches continuation preflight for its precise
    // immutable-field error.
    const inheritedWritable =
      task.resumed?.allowWrites ?? Boolean(task.resumed?.worktreeId);
    const changesInheritedMode =
      Boolean(task.resumed) &&
      ((task.writeRequestExplicit &&
        task.writeRequested !== inheritedWritable) ||
        (task.isolationExplicit && task.isolation !== task.resumed?.isolation));
    const inheritedWritableShared =
      Boolean(task.resumed) &&
      inheritedWritable &&
      task.resumed?.isolation === 'shared' &&
      !changesInheritedMode;
    if (
      (!task.resumed && task.writeRequested && task.isolation === 'shared') ||
      inheritedWritableShared
    )
      invalidParams(
        'Writable delegates require worktree isolation; shared writable delegates are not supported.',
      );
    if (
      !task.resumed &&
      (task.input.from !== undefined || shared.from !== undefined) &&
      task.isolation === 'shared'
    )
      invalidParams(
        'from requires worktree isolation; it cannot be used with a shared delegate.',
      );
    if (
      !task.resumed &&
      task.worktreePath &&
      (task.input.from !== undefined || shared.from !== undefined)
    )
      invalidParams(
        'worktreePath selects the existing branch state and cannot be combined with from.',
      );
    if (!task.resumed && task.worktreePath && task.isolation === 'shared')
      invalidParams(
        'worktreePath requires worktree isolation; shared delegates cannot select a checkout.',
      );
  }

  if (parallel) writeWarnings(namedTasks);

  for (const task of namedTasks) {
    if (
      !task.resumed &&
      task.context === 'branch' &&
      !getSnapshot(task.requestedCwd)
    )
      invalidParams(
        'Cannot delegate: failed to snapshot current session branch.',
      );
  }

  for (const task of namedTasks) {
    if ((task.input.refresh ?? shared.refresh) !== undefined && !task.resumed)
      invalidParams(
        'refresh is only available on a read-only worktree continuation.',
      );
  }

  const builtTasks = namedTasks.map((task) => ({
    ...task,
    plan: {
      name: task.input.name,
      task: task.input.task,
      requestedCwd: task.requestedCwd,
      cwdExplicit: task.input.cwd !== undefined || shared.cwd !== undefined,
      context: task.context,
      contextNote: task.input.contextNote ?? shared.contextNote,
      scope: task.scope,
      base: task.input.from ?? shared.from,
      refresh: task.input.refresh ?? shared.refresh,
      worktreePath: task.worktreePath,
      handoffFrom: normalizeHandoffFrom(
        task.input.handoffFrom ?? shared.handoffFrom,
      ),
      writeRequested: task.writeRequested,
      isolation: task.isolation,
      allowWritesExplicit: task.writeRequestExplicit,
      isolationExplicit: task.isolationExplicit,
      routing: task.routing,
      resumed: task.resumed,
      routeOverride: Boolean(
        task.resumed && (task.input.route ?? shared.route) !== undefined,
      ),
      snapshotJsonl:
        task.context === 'branch'
          ? (getSnapshot(task.requestedCwd) ?? undefined)
          : undefined,
      warnings: task.warnings,
    } satisfies DelegateTaskPlan,
  }));

  let preparedTasks: BuiltDelegateTask[];
  try {
    preparedTasks = builtTasks.map(({ plan }) => ({
      plan,
      preflight: preflightDelegateContinuation(plan),
    }));
  } catch (error) {
    invalidParams(errorText(error));
  }

  return { parallel, tasks: preparedTasks };
}

function handoffError(ref: DelegateHandoffFrom, reason: string): never {
  invalidParams(`Invalid handoffFrom artifact ${ref.handle}: ${reason}`);
}

/** Resolve parent-owned artifacts before any child setup or launch occurs. */
export async function resolveDelegateHandoffs(
  ctx: ExtensionContext,
  tasks: BuiltDelegateTask[],
  resolver: typeof resolveArtifact = resolveArtifact,
): Promise<BuiltDelegateTask[]> {
  let aggregatePromptBytes = 0;
  const resolved: BuiltDelegateTask[] = [];
  for (const task of tasks) {
    const plan = task.plan;
    const refs = plan.handoffFrom
      ? Array.isArray(plan.handoffFrom)
        ? plan.handoffFrom
        : [plan.handoffFrom]
      : undefined;
    if (!refs?.length) {
      resolved.push(task);
      continue;
    }
    if (refs.length > 4) {
      const limitRef = refs[4] ?? refs.at(-1);
      if (!limitRef)
        invalidParams('A child handoff list is unexpectedly empty.');
      handoffError(limitRef, 'a child may forward at most 4 artifacts');
    }
    const seenHandles = new Set<string>();
    for (const ref of refs) {
      if (!ref.handle.trim()) handoffError(ref, 'the handle is empty');
      const duplicateKey = ref.handle;
      if (seenHandles.has(duplicateKey))
        handoffError(ref, 'the handle is duplicated for this child');
      seenHandles.add(duplicateKey);
    }
    const framed: string[] = [];
    for (const ref of refs) {
      let artifact: Awaited<ReturnType<typeof resolveArtifact>>;
      try {
        artifact = await resolver(ctx, ref.handle);
      } catch {
        handoffError(ref, 'it could not be resolved in the current session');
      }
      if (!artifact)
        handoffError(ref, 'it was not found in the current session');
      if (
        artifact.metadata.producer !== 'delegate' ||
        artifact.metadata.contentClass !== 'delegate-output' ||
        artifact.metadata.encoding !== 'utf-8'
      )
        handoffError(ref, 'it is not a textual delegate-output artifact');
      if (artifact.bytes.length > DELEGATE_HANDOFF_CAPS.perItemMaxBytes)
        handoffError(
          ref,
          `it exceeds the ${DELEGATE_HANDOFF_CAPS.perItemMaxBytes} byte raw-artifact per-item limit`,
        );
      const label = ref.label?.trim() || ref.handle;
      const text = artifact.bytes.toString('utf8');
      const frame = frameWorkflowEvidence(label, text, 'artifact');
      const itemPromptBytes = workflowEvidencePromptBytes([frame]);
      if (itemPromptBytes > DELEGATE_HANDOFF_CAPS.perItemMaxBytes)
        handoffError(
          ref,
          `its actual framed prompt bytes exceed the ${DELEGATE_HANDOFF_CAPS.perItemMaxBytes} byte per-item limit`,
        );
      framed.push(frame);
    }
    const promptBytes = workflowEvidencePromptBytes(framed);
    aggregatePromptBytes += promptBytes;
    if (aggregatePromptBytes > DELEGATE_HANDOFF_CAPS.aggregateMaxBytes) {
      const lastRef = refs.at(-1);
      if (!lastRef)
        invalidParams('A child handoff list is unexpectedly empty.');
      handoffError(
        lastRef,
        `the actual forwarded prompt bytes exceed the ${DELEGATE_HANDOFF_CAPS.aggregateMaxBytes} byte aggregate limit`,
      );
    }
    resolved.push({
      ...task,
      plan: {
        ...plan,
        handoffText: framed.join('\n\n'),
      },
    });
  }
  return resolved;
}
