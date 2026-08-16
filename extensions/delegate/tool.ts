import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type Static, Type } from 'typebox';
import { loadGuidelines } from '../shared/instructions';
import {
  type DelegateConfig,
  loadDelegateConfig,
  resolveDelegateRoute,
} from './config';
import { createDelegateControlChannel } from './control';
import type { DelegateJobManager } from './jobs';
import {
  pendingRuns,
  prepareDelegateExecution,
  prepareDelegateWorkflowLaunch,
  runPreparedDelegateExecution,
} from './orchestration';
import { invalidParams } from './param-errors';
import { buildDelegatePlans } from './plans';
import { renderDelegateCall, renderDelegateResult } from './render';
import { formatDelegateRoutingPrompt } from './routing';
import { buildSessionSnapshotJsonl } from './session';
import type { DelegateStatusStore } from './status';
import { serializeDelegateRunForPublic } from './structured-result';
import { rollbackPreparedDelegateTasks } from './task-lifecycle';
import {
  buildSessionBoundArtifactBackedHandoff,
  delegateToolResult,
  makeDetails,
} from './tool-result';
import { createRun } from './types';
import type {
  DelegateWorkflowAttemptSnapshot,
  DelegateWorkflowCoordinator,
} from './workflow-coordinator';
import { parseWorkflowReference } from './workflow-model';

const DELEGATE_TOOL_DESCRIPTION =
  'Schedule one focused child agent asynchronously. Choose a route, workspace mode, and either a prose or structured result contract; use after and inputs to compose work and delegate_wake to receive selected results.';

const RouteSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  description:
    'Delegate catalog route; fresh tasks require it, continuations inherit it when omitted.',
});
const ContextSchema = StringEnum(['branch', 'fresh'] as const, {
  description:
    'Optional context mode. fresh starts with the task and project instructions; branch also includes parent conversation history.',
});
const ScopeSchema = Type.Array(Type.String({ maxLength: 4096 }), {
  maxItems: 100,
  description: 'Advisory paths for expected work; not a hard boundary.',
});
const BaseSchema = StringEnum(['wip', 'head'] as const, {
  description:
    "Where a worktree-isolated task's branch starts. wip (default) carries your uncommitted changes into the worktree so the child sees the repository as you see it; head starts from the last commit instead.",
});
const AllowWritesSchema = Type.Boolean({
  description:
    'Let a task edit files. This does not sandbox shell commands; continuations inherit it when omitted and cannot change it explicitly.',
});
const IsolationSchema = StringEnum(['shared', 'worktree'] as const, {
  description:
    'Repository workspace mode. Worktrees isolate checkout files, not shell or external side effects; fresh read-only tasks default to shared and writable tasks to worktree. Writable shared tasks are rejected. Continuations inherit this when omitted and cannot change it explicitly.',
});
const WorktreePathSchema = Type.String({
  minLength: 1,
  maxLength: 4096,
  description:
    'Absolute path to an existing clean Git worktree belonging to cwd. Uses that caller-owned checkout directly; no nested checkout, branch, commit, merge, or deletion is performed by the harness.',
});
const RefreshSchema = StringEnum(['wip', 'head'] as const, {
  description:
    'Continuation-only snapshot selector. For a read-only isolated continuation, wip recreates from the parent’s current tracked and untracked work; head recreates from current HEAD only. Omit to continue the original snapshot.',
});

const HandoffArtifactSchema = Type.Object({
  handle: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: '^art_[A-Za-z0-9_-]{22}$',
    description: 'Artifact handle from a prior delegate result in this session',
  }),
  label: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 120,
      description:
        'Optional label for the upstream evidence in the child prompt',
    }),
  ),
  view: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z][A-Za-z0-9_-]*$',
      description: 'Named schema-selected view of the full delegate artifact',
    }),
  ),
});

const HandoffFromListSchema = Type.Array(HandoffArtifactSchema, {
  minItems: 1,
  maxItems: 4,
  description: 'Ordered prior delegate-output artifacts to forward',
});

// Accept the original object form as a one-item shorthand while making the
// ordered array form explicit for children that need several upstream reports.
const HandoffFromSchema = Type.Union([
  HandoffArtifactSchema,
  HandoffFromListSchema,
]);

const ResultProjectionSchema = Type.Optional(
  Type.Union([
    Type.Literal('all', {
      description: 'Expose the complete bounded result to the parent',
    }),
    Type.Array(Type.String({ maxLength: 256 }), {
      maxItems: 32,
      description:
        'Static result paths selected for the compact parent envelope; use "/" for the complete result',
    }),
  ]),
);
const ResultViewsSchema = Type.Optional(
  Type.Record(
    Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z][A-Za-z0-9_-]*$',
    }),
    Type.String({ maxLength: 256 }),
    { maxProperties: 16 },
  ),
);
const ResultSpecSchema = Type.Object(
  {
    shape: Type.Optional(
      Type.Any({
        description:
          'Recommended complete result shape: primitive type tokens; required-by-default object fields; one-item arrays for homogeneous lists; multi-literal arrays for enums; exact {$optional: shape} wrappers; and $type descriptors for constraints',
      }),
    ),
    projection: ResultProjectionSchema,
    views: ResultViewsSchema,
  },
  { additionalProperties: false },
);

export type DelegateHandoffFrom = Static<typeof HandoffArtifactSchema>;
export type DelegateHandoffInput = Static<typeof HandoffFromSchema>;
export type DelegateResultSpec = Static<typeof ResultSpecSchema>;

const LogicalIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
  description: 'Stable logical node ID; fresh calls require one.',
});
const AfterSchema = Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
  maxItems: 32,
  description: 'Exact or bare logical attempts that must settle first.',
});
const WorkflowInputSchema = Type.Object(
  {
    node: Type.String({ minLength: 1, maxLength: 512 }),
    include: Type.Optional(
      Type.Array(
        StringEnum(['report', 'handoff', 'branch', 'metadata'] as const),
        { minItems: 1, maxItems: 4 },
      ),
    ),
    view: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$',
      }),
    ),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);
const ContinueSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  description: 'Logical node or exact attempt to continue after settlement.',
});

const NameSchema = Type.String({
  minLength: 1,
  maxLength: 120,
  description:
    'Display name; required for fresh tasks and inherited by continuations when omitted.',
});

const TaskSchema = Type.String({
  minLength: 1,
  maxLength: 32 * 1024,
  description: 'Focused task or continuation feedback',
});
const CwdSchema = Type.String({ maxLength: 4096 });
const ContextNoteSchema = Type.String({
  maxLength: 64 * 1024,
  description: 'Curated context from the parent agent',
});
const ContinuationSchema = Type.String({
  maxLength: 512,
  description: 'Opaque token from a previous delegate run',
});

const TaskItem = Type.Object({
  name: Type.Optional(NameSchema),
  task: TaskSchema,
  cwd: Type.Optional(CwdSchema),
  route: Type.Optional(RouteSchema),
  context: Type.Optional(ContextSchema),
  contextNote: Type.Optional(ContextNoteSchema),
  scope: Type.Optional(ScopeSchema),
  continuation: Type.Optional(ContinuationSchema),
  allowWrites: Type.Optional(AllowWritesSchema),
  isolation: Type.Optional(IsolationSchema),
  from: Type.Optional(BaseSchema),
  refresh: Type.Optional(RefreshSchema),
  worktreePath: Type.Optional(WorktreePathSchema),
  handoffFrom: Type.Optional(HandoffFromSchema),
  result: Type.Optional(ResultSpecSchema),
});

const DelegateCommonParamProperties = {
  after: Type.Optional(AfterSchema),
  inputs: Type.Optional(Type.Array(WorkflowInputSchema, { maxItems: 4 })),
  name: Type.Optional(NameSchema),
  task: TaskSchema,
  cwd: Type.Optional(CwdSchema),
  route: Type.Optional(RouteSchema),
  context: Type.Optional(ContextSchema),
  contextNote: Type.Optional(ContextNoteSchema),
  scope: Type.Optional(ScopeSchema),
  allowWrites: Type.Optional(AllowWritesSchema),
  isolation: Type.Optional(IsolationSchema),
  from: Type.Optional(BaseSchema),
  refresh: Type.Optional(RefreshSchema),
  worktreePath: Type.Optional(WorktreePathSchema),
  handoffFrom: Type.Optional(HandoffFromSchema),
  result: Type.Optional(ResultSpecSchema),
};

type DelegateCommonParams = Omit<Static<typeof TaskItem>, 'continuation'> & {
  after?: Static<typeof AfterSchema>;
  inputs?: Array<Static<typeof WorkflowInputSchema>>;
};
type ModelDelegateParams = DelegateCommonParams &
  ({ id: string; continue?: never } | { continue: string; id?: never });

const DelegateParamsSchema = Type.Unsafe<ModelDelegateParams>({
  type: 'object',
  properties: {
    id: LogicalIdSchema,
    continue: ContinueSchema,
    ...DelegateCommonParamProperties,
  },
  required: ['task'],
  additionalProperties: false,
  oneOf: [
    { required: ['id'], not: { required: ['continue'] } },
    { required: ['continue'], not: { required: ['id'] } },
  ],
});

/** Internal compatibility shape used below the closed model-facing schema. */
export type DelegateParams = Partial<DelegateCommonParams> & {
  id?: string;
  continue?: string;
  tasks?: Array<Static<typeof TaskItem>>;
  continuation?: string;
  background?: boolean;
};

export function delegatePromptGuidelines(
  cwd: string,
  config?: DelegateConfig,
): string[] {
  return [
    // Parent workflow preferences belong to the delegate extension and are
    // validated as bullet-only guidelines at load time.
    ...loadGuidelines('instructions.md', __dirname),
    `Delegate route catalog:\n${formatDelegateRoutingPrompt(cwd, config)}`,
  ];
}

function workflowReceipt(attempt: DelegateWorkflowAttemptSnapshot): {
  content: [{ type: 'text'; text: string }];
  details: Record<string, unknown>;
} {
  const job = attempt.jobId ? `; adapter=${attempt.jobId}` : '';
  const waiting = attempt.dependencies.length
    ? ` after ${attempt.dependencies.join(', ')}`
    : '';
  return {
    content: [
      {
        type: 'text',
        text: `Scheduled ${attempt.identity}${waiting}; state=${attempt.state}${job}. Register delegate_wake before settling if this work gates the next decision.`,
      },
    ],
    details: {
      workflow: {
        identity: attempt.identity,
        logicalId: attempt.logicalId,
        ordinal: attempt.ordinal,
        state: attempt.state,
        dependencies: [...attempt.dependencies],
        inputs: attempt.inputs.map((input) => ({
          identity: input.identity,
          selector: {
            ...input.selector,
            ...(input.selector.include
              ? { include: [...input.selector.include] }
              : {}),
          },
        })),
        ...(attempt.route ? { route: attempt.route } : {}),
        ...(attempt.jobId ? { jobId: attempt.jobId } : {}),
      },
    },
  };
}

export interface DelegateBackgroundRuntime {
  /** Session-scoped logical workflow coordinator. */
  workflow?: DelegateWorkflowCoordinator;
  manager: DelegateJobManager;
  statuses: DelegateStatusStore;
  getDeliveryEpoch: () => number;
  activateJobs?: () => void;
  activateBranches?: () => void;
}

export function registerDelegateTool(
  pi: ExtensionAPI,
  cwd: string,
  backgroundRuntime?: DelegateBackgroundRuntime,
  promptConfig?: DelegateConfig,
): void {
  pi.registerTool({
    name: 'delegate',
    label: 'Delegate',
    description: DELEGATE_TOOL_DESCRIPTION,
    promptSnippet:
      'Schedule one focused async delegate with a stable id; compose with after/inputs, register delegate_wake for required results, then continue or settle without polling.',
    promptGuidelines: delegatePromptGuidelines(cwd, promptConfig),
    parameters: DelegateParamsSchema,
    renderCall: renderDelegateCall,
    renderResult: renderDelegateResult,

    async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as DelegateParams;
      const config = loadDelegateConfig(ctx.cwd);
      const snapshots = new Map<string, string | null>();
      const getSnapshot = (targetCwd: string) => {
        if (snapshots.has(targetCwd)) return snapshots.get(targetCwd) ?? null;
        const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager, {
          cwd: targetCwd,
          excludeToolCallId: toolCallId,
        });
        snapshots.set(targetCwd, snapshot);
        return snapshot;
      };

      const launchSessionId = ctx.sessionManager.getSessionId();
      const runCtx = {
        pi,
        ctx,
        config,
        signal,
        getSnapshot,
        launchSessionId,
      };
      // Legacy batch payloads and calls without a logical id stay behind this
      // boundary. A new id/continue call treats background as a no-op and
      // always uses the coordinator.
      const legacySurface =
        Array.isArray((rawParams as { tasks?: unknown }).tasks) ||
        (params.id === undefined && params.continue === undefined);

      if (backgroundRuntime?.workflow && !legacySurface) {
        if (Array.isArray(params.tasks))
          throw new Error(
            'A delegate call schedules one logical node at a time.',
          );
        const task = params.task?.trim();
        if (!task) throw new Error('Delegate task is required.');
        const continuationReference = params.continue?.trim();
        if (continuationReference && params.id !== undefined)
          throw new Error(
            'Use either id for a fresh node or continue, not both.',
          );
        const logicalId = continuationReference
          ? parseWorkflowReference(continuationReference).logicalId
          : params.id?.trim();
        if (!logicalId)
          throw new Error('Fresh delegate calls require a stable id.');
        if (continuationReference)
          backgroundRuntime.workflow.require(continuationReference);
        const requestedRoute = params.route?.trim();
        const inheritedRouting = continuationReference
          ? backgroundRuntime.workflow.getRouting(continuationReference)
          : undefined;
        const routeResult =
          requestedRoute || !continuationReference
            ? resolveDelegateRoute(requestedRoute, config)
            : { routing: inheritedRouting };
        if (routeResult.error || !routeResult.routing)
          throw new Error(
            routeResult.error ??
              'The predecessor has no persisted route; provide route explicitly.',
          );
        const routing = routeResult.routing;
        let initialPlan:
          | import('./task-lifecycle').DelegateTaskPlan
          | undefined;
        if (!continuationReference) {
          const built = buildDelegatePlans(
            {
              ...params,
              id: undefined,
              name: params.name?.trim() || logicalId,
              task,
            },
            ctx,
            config,
            getSnapshot,
          );
          if (built.parallel || built.tasks.length !== 1)
            throw new Error(
              'A delegate call schedules one logical node at a time.',
            );
          initialPlan = built.tasks[0]?.plan;
          if (!initialPlan) throw new Error('Delegate plan was not created.');
        }
        const pending = createRun(task, routing, {
          name: params.name?.trim() || logicalId,
          context: continuationReference
            ? 'continuation'
            : (params.context ?? 'fresh'),
          allowWrites: params.allowWrites,
          writeRequested: params.allowWrites,
          isolation: params.isolation,
        });
        const statusIds = backgroundRuntime.statuses.start(
          [pending],
          'background',
        );
        try {
          const attempt = backgroundRuntime.workflow.schedule({
            logicalId,
            continuation: continuationReference,
            after: params.after,
            inputs: params.inputs as
              | import('./workflow-inputs').SymbolicWorkflowSelector[]
              | undefined,
            name: params.name?.trim() || logicalId,
            ownerSessionId: launchSessionId,
            route: routing.route,
            routing,
            prepare: async (workflowContext) => {
              let plan = initialPlan;
              if (!plan) {
                const token = workflowContext.continuationToken;
                if (!token)
                  throw new Error(
                    'The predecessor has no usable continuation token.',
                  );
                const built = buildDelegatePlans(
                  {
                    ...params,
                    id: undefined,
                    continue: undefined,
                    continuation: token,
                    name: params.name?.trim() || logicalId,
                    route: requestedRoute,
                    task,
                  },
                  ctx,
                  config,
                  getSnapshot,
                );
                if (built.parallel || built.tasks.length !== 1)
                  throw new Error('A continuation must contain one task.');
                plan = built.tasks[0]?.plan;
              }
              if (!plan)
                throw new Error('Delegate continuation plan was not created.');
              if (
                !plan.routing ||
                plan.routing.route !== routing.route ||
                plan.routing.provider !== routing.provider ||
                plan.routing.model !== routing.model ||
                plan.routing.thinking !== routing.thinking ||
                plan.routing.relativeCost !== routing.relativeCost
              )
                throw new Error(
                  'Delegate route changed while preparing the attempt.',
                );
              return prepareDelegateWorkflowLaunch(
                runCtx,
                plan,
                workflowContext,
                {
                  onRunUpdate: (run) => {
                    const statusId = statusIds[0];
                    if (statusId)
                      backgroundRuntime.statuses.update(statusId, run);
                    if (run.worktree) backgroundRuntime.activateBranches?.();
                  },
                },
              );
            },
          });
          const statusId = statusIds[0];
          if (statusId)
            backgroundRuntime.statuses.setWorkflow(statusId, attempt);
          if (statusId && attempt.jobId)
            backgroundRuntime.statuses.setJobId(statusId, attempt.jobId);
          const updateTerminalStatus = (
            terminal: DelegateWorkflowAttemptSnapshot,
          ) => {
            if (!statusId) return;
            const run = backgroundRuntime.workflow?.getResult(terminal.identity)
              ?.runs[0];
            if (run) backgroundRuntime.statuses.update(statusId, run);
          };
          if (attempt.settledAt !== undefined) updateTerminalStatus(attempt);
          else {
            let unsubscribe: (() => void) | undefined;
            unsubscribe = backgroundRuntime.workflow.subscribeTerminal(
              (terminal) => {
                if (terminal.identity !== attempt.identity) return;
                updateTerminalStatus(terminal);
                unsubscribe?.();
              },
            );
          }
          backgroundRuntime.activateJobs?.();
          if (attempt.state === 'running' && statusId)
            backgroundRuntime.statuses.update(statusId, {
              ...pending,
              state: 'running',
              startedAt: attempt.startedAt,
            });
          return workflowReceipt(attempt) as unknown as {
            content: Array<{ type: 'text'; text: string }>;
            details: import('./types').LegacyDelegateDetails;
          };
        } catch (error) {
          backgroundRuntime.statuses.finish(statusIds);
          throw error;
        }
      }

      const hasSingle =
        typeof params.task === 'string' && params.task.trim().length > 0;
      const hasParallel =
        Array.isArray(params.tasks) && params.tasks.length > 0;
      if (hasSingle === hasParallel)
        return invalidParams(
          'Provide exactly one delegation mode: task or tasks.',
        );

      if (params.background && !backgroundRuntime)
        throw new Error('Background delegate runtime is unavailable.');
      const execution = await prepareDelegateExecution(runCtx, params);
      const initialRuns = pendingRuns(execution);
      const statusIds = backgroundRuntime?.statuses.start(
        initialRuns,
        params.background ? 'background' : 'foreground',
      );

      if (params.background) {
        if (!backgroundRuntime)
          throw new Error('Background delegate runtime is unavailable.');
        const materializeHandoff = async (
          materializeCtx: typeof ctx,
          runs: import('./types').DelegatedRun[],
          statusId?: string,
        ) => {
          const handoff = await buildSessionBoundArtifactBackedHandoff(
            pi,
            materializeCtx,
            launchSessionId,
            runs,
          );
          const ownerSession =
            materializeCtx.sessionManager.getSessionId() === launchSessionId;
          const publicRuns = runs.map((run) =>
            serializeDelegateRunForPublic(run, {
              includeArtifacts: ownerSession,
            }),
          );
          if (ownerSession && statusId && publicRuns[0])
            backgroundRuntime.statuses.update(statusId, publicRuns[0]);
          return {
            runs: ownerSession
              ? publicRuns
              : publicRuns.map((run) => ({ ...run, artifact: undefined })),
            retainedRuns: runs,
            handoff,
          };
        };
        const controls = execution.tasks.map((item, index) => {
          const control = createDelegateControlChannel(
            item.session.filePath,
            launchSessionId,
            'background',
          );
          const statusId = statusIds?.[index];
          if (statusId) control.bindStatusId(statusId);
          return control;
        });
        let jobs: ReturnType<DelegateJobManager['startMany']>;
        try {
          jobs = backgroundRuntime.manager.startMany(
            execution.tasks.map((item, index) => {
              const control = controls[index];
              if (!control)
                throw new Error('Missing delegate control channel.');
              return {
                name: item.plan.name,
                ownerSessionId: launchSessionId,
                mode: 'single' as const,
                tasks: [item.plan.task],
                deliveryEpoch: backgroundRuntime.getDeliveryEpoch(),
                route: item.plan.routing?.route,
                allowWrites: item.allowWrites,
                feedback: (message) => control.enqueue('feedback', message),
                execute: async (jobSignal) => {
                  try {
                    const runs = await runPreparedDelegateExecution(
                      { ...runCtx, signal: jobSignal },
                      { mode: 'single', tasks: [item] },
                      {
                        control,
                        onRunUpdate: (run) => {
                          if (statusIds?.[index])
                            backgroundRuntime.statuses.update(
                              statusIds[index],
                              run,
                            );
                        },
                      },
                    );
                    // The child is settled before owner-session artifact
                    // materialization; reject feedback during that recovery
                    // window rather than reporting it as delivered.
                    control.close();
                    const run = runs[0];
                    if (run && statusIds?.[index])
                      backgroundRuntime.statuses.update(statusIds[index], run);
                    return materializeHandoff(ctx, runs, statusIds?.[index]);
                  } finally {
                    control.close();
                  }
                },
                materialize: (materializeCtx, runs) =>
                  materializeHandoff(materializeCtx, runs, statusIds?.[index]),
              };
            }),
          );
        } catch (error) {
          for (const control of controls) control.close();
          if (statusIds) backgroundRuntime.statuses.finish(statusIds);
          const warnings = await rollbackPreparedDelegateTasks(execution.tasks);
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `${message}${warnings.length ? ` Cleanup warnings: ${warnings.join(' ')}` : ''}`,
          );
        }
        for (const [index, run] of initialRuns.entries()) {
          run.backgroundJobId = jobs[index]?.id;
          if (statusIds?.[index] && jobs[index]?.id)
            backgroundRuntime.statuses.setJobId(
              statusIds[index],
              jobs[index].id,
            );
        }
        backgroundRuntime.activateJobs?.();
        if (initialRuns.some((run) => run.worktree))
          backgroundRuntime.activateBranches?.();
        const jobLines = initialRuns.map((run, index) => {
          const id = jobs[index]?.id ?? `job ${index + 1}`;
          return `${id}${run.continuation ? ` continuation: ${run.continuation}` : ''}`;
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Started ${jobs.length} background delegate ${jobs.length === 1 ? 'job' : 'jobs'}: ${jobs.map((job) => job.id).join(', ')}. Each subagent completion will be delivered automatically. Continue independent work when useful. Use delegate_jobs feedback for bounded corrective steering, peek for deliberate inspection, and /continue to resume manually after an interruption.\n${jobLines.join('\n')}`.trim(),
            },
          ],
          details: makeDetails(execution.mode, initialRuns),
        };
      }

      const controls = execution.tasks.map((item, index) => {
        const control = createDelegateControlChannel(
          item.session.filePath,
          launchSessionId,
          'foreground',
        );
        const statusId = statusIds?.[index];
        if (statusId) control.bindStatusId(statusId);
        return control;
      });
      let runs: Awaited<ReturnType<typeof runPreparedDelegateExecution>>;
      try {
        runs = await runPreparedDelegateExecution(runCtx, execution, {
          controls,
          onRunUpdate: (run, index = 0) => {
            const statusId = statusIds?.[index];
            if (statusId) backgroundRuntime?.statuses.update(statusId, run);
          },
          onUpdate,
        });
      } catch (error) {
        if (statusIds) backgroundRuntime?.statuses.finish(statusIds);
        throw error;
      } finally {
        for (const control of controls) control.close();
      }
      if (runs.some((run) => run.worktree))
        backgroundRuntime?.activateBranches?.();
      const result = await delegateToolResult(
        pi,
        ctx,
        execution.mode,
        runs,
        launchSessionId,
      );
      if (statusIds) {
        // delegateToolResult publishes lifecycle diagnostics before returning;
        // refresh terminal status with that owner-safe projection rather than
        // leaving live status at its pre-materialization view.
        backgroundRuntime?.statuses.updateMany(statusIds, runs);
        backgroundRuntime?.statuses.resultEntered(statusIds);
      }
      return result;
    },
  });
}
