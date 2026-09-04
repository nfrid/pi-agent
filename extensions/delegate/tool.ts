import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { type Static, Type } from 'typebox';
import { codexServiceTier } from '../shared/codex-service-tier';
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
  preflightSymbolicBranchPlan,
  preflightSymbolicBranchRequest,
  prepareDelegateExecution,
  prepareDelegateWorkflowLaunch,
  runPreparedDelegateExecution,
} from './orchestration';
import { invalidParams } from './param-errors';
import { assertContinuationFields, buildDelegatePlans } from './plans';
import { renderDelegateCall, renderDelegateResult } from './render';
import { formatDelegateRoutingPrompt } from './routing';
import { serializeDelegateRunForPublic } from './serialize';
import { buildSessionSnapshotJsonl } from './session';
import type { DelegateStatusStore } from './status';
import { rollbackPreparedDelegateTasks } from './task-lifecycle';
import {
  buildOutputFileHandoff,
  delegateToolResult,
  makeDetails,
} from './tool-result';
import { createRun } from './types';
import type {
  DelegateWorkflowAttemptSnapshot,
  DelegateWorkflowCoordinator,
} from './workflow-coordinator';
import { parseWorkflowReference } from './workflow-model';
import { captureWorkInProgress } from './worktree';

const DELEGATE_TOOL_DESCRIPTION =
  'Schedule one focused child agent asynchronously. Use a stable id or continue reference, inputs to wait for reports, base to start from an upstream code state, and write or web when needed.';

const RouteSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  description:
    'Delegate catalog route; fresh tasks require it, continuations inherit it when omitted.',
});
const ScopeSchema = Type.Array(Type.String({ maxLength: 4096 }), {
  maxItems: 100,
  description:
    'Advisory paths for expected work; not a hard boundary. Continuations inherit the latest scope when omitted and replace it when supplied.',
});
const BaseSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  description:
    'Logical node or exact attempt whose recorded code state becomes the fresh isolated workspace base.',
});
const WriteSchema = Type.Boolean({
  description:
    'Let a task edit files. Continuations inherit the original write capability and cannot change it.',
});
const WebSchema = Type.Boolean({
  description:
    'Enable web_search, fetch_content, and get_search_content for this delegate. Continuations inherit the original capability.',
});

const LogicalIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
  description: 'Stable logical node ID; fresh calls require one.',
});
const ContinueSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  description: 'Logical node or exact attempt to continue after settlement.',
});
const TaskSchema = Type.String({
  minLength: 1,
  maxLength: 32 * 1024,
  description: 'Focused task or continuation feedback',
});
const CwdSchema = Type.String({
  maxLength: 4096,
  description:
    'Fresh delegates inherit ctx.cwd when omitted. Relative paths resolve against ctx.cwd; ~ and ~/ paths expand using the effective home directory; absolute paths are supported. Continuations retain their persisted cwd and must omit this field.',
});

type LegacyWorkflowInput = {
  node: string;
  include?: Array<'report' | 'handoff' | 'branch' | 'metadata'>;
  label?: string;
};
type LegacyTaskInput = {
  name?: string;
  task: string;
  cwd?: string;
  route?: string;
  context?: 'branch' | 'fresh';
  contextNote?: string;
  scope?: string[];
  continuation?: string;
  allowWrites?: boolean;
  capabilities?: Array<'web'>;
  isolation?: 'shared' | 'worktree';
  from?: 'wip' | 'head';
  refresh?: 'wip' | 'head';
  worktreePath?: string;
};
type DelegateCommonParams = Omit<LegacyTaskInput, 'continuation'> & {
  after?: string[];
  inputs?: LegacyWorkflowInput[];
};
type ModelDelegateParams = {
  task: Static<typeof TaskSchema>;
  route?: Static<typeof RouteSchema>;
  inputs?: string[];
  base?: Static<typeof BaseSchema>;
  scope?: Static<typeof ScopeSchema>;
  write?: Static<typeof WriteSchema>;
  cwd?: Static<typeof CwdSchema>;
  web?: Static<typeof WebSchema>;
} & ({ id: string; continue?: never } | { continue: string; id?: never });

const DelegateParamsSchema = Type.Unsafe<ModelDelegateParams>({
  type: 'object',
  properties: {
    id: LogicalIdSchema,
    continue: ContinueSchema,
    task: TaskSchema,
    route: Type.Optional(RouteSchema),
    inputs: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        maxItems: 4,
      }),
    ),
    base: Type.Optional(BaseSchema),
    scope: Type.Optional(ScopeSchema),
    write: Type.Optional(WriteSchema),
    cwd: Type.Optional(CwdSchema),
    web: Type.Optional(WebSchema),
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
  tasks?: LegacyTaskInput[];
  continuation?: string;
  background?: boolean;
};

/** Translate the small model contract into the durable execution shape. */
function normalizeModelParams(rawParams: unknown): DelegateParams {
  const raw = (rawParams ?? {}) as Record<string, unknown>;
  // Legacy batch calls are not model-facing, so leave their established shape
  // untouched for background and internal callers.
  if (
    Array.isArray(raw.tasks) ||
    (raw.id === undefined && raw.continue === undefined)
  )
    return raw as DelegateParams;

  const continuation =
    typeof raw.continue === 'string' ? raw.continue.trim() : undefined;
  const logicalId =
    typeof raw.id === 'string'
      ? raw.id.trim()
      : continuation
        ? parseWorkflowReference(continuation).logicalId
        : undefined;
  if (!logicalId) throw new Error('Fresh delegate calls require a stable id.');

  const selectors: LegacyWorkflowInput[] = [];
  const base = typeof raw.base === 'string' ? raw.base.trim() : undefined;
  if (base) selectors.push({ node: base, include: ['branch', 'report'] });
  if (Array.isArray(raw.inputs))
    for (const input of raw.inputs) {
      // Object selectors are retained only for direct internal/test callers;
      // the registered schema admits strings exclusively.
      if (typeof input === 'string') {
        const node = input.trim();
        if (node !== base) selectors.push({ node });
      } else if (input && typeof input === 'object')
        selectors.push(input as LegacyWorkflowInput);
    }

  return {
    ...(typeof raw.task === 'string' ? { task: raw.task } : {}),
    ...(typeof raw.route === 'string' ? { route: raw.route } : {}),
    ...(selectors.length ? { inputs: selectors } : {}),
    ...(Array.isArray(raw.after) ? { after: raw.after as string[] } : {}),
    ...(typeof raw.scope !== 'undefined'
      ? { scope: raw.scope as string[] }
      : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...(typeof raw.write === 'boolean'
      ? { allowWrites: raw.write }
      : typeof raw.allowWrites === 'boolean'
        ? { allowWrites: raw.allowWrites }
        : {}),
    ...(typeof raw.web === 'boolean'
      ? { capabilities: raw.web ? (['web'] as const) : [] }
      : Array.isArray(raw.capabilities)
        ? { capabilities: raw.capabilities as 'web'[] }
        : {}),
    // These fields are accepted only for direct legacy/runtime callers, never
    // by the registered model schema.
    ...(raw.context === 'branch' || raw.context === 'fresh'
      ? { context: raw.context }
      : {}),
    ...(typeof raw.contextNote === 'string'
      ? { contextNote: raw.contextNote }
      : {}),
    ...(raw.isolation === 'shared' || raw.isolation === 'worktree'
      ? { isolation: raw.isolation }
      : {}),
    ...(raw.from === 'wip' || raw.from === 'head' ? { from: raw.from } : {}),
    ...(typeof raw.worktreePath === 'string'
      ? { worktreePath: raw.worktreePath }
      : {}),
    ...(typeof raw.id === 'string'
      ? { id: logicalId }
      : { continue: continuation }),
  } as DelegateParams;
}

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
  const waiting = attempt.dependencies.length
    ? ` after ${attempt.dependencies.join(', ')}`
    : '';
  return {
    content: [
      {
        type: 'text',
        text: `Scheduled ${attempt.identity}${waiting}; state=${attempt.state}. Results arrive eagerly unless held by delegate_gate.`,
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
  /** Session-scoped logical workflow coordinator (legacy static form). */
  workflow?: DelegateWorkflowCoordinator;
  /** Current branch runtime selected by session_tree. */
  getWorkflow?: () => DelegateWorkflowCoordinator | undefined;
  manager: DelegateJobManager;
  statuses: DelegateStatusStore;
  getStatuses?: () => DelegateStatusStore | undefined;
  /** Current immutable branch owner, when the host exposes branch identity. */
  getBranchId?: () => string | undefined;
  ensureBranchOwner?: (ctx: ExtensionContext) => void;
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
      'Schedule one focused async delegate with a stable id; compose with inputs or base. Results arrive as any at a safe boundary by default; use delegate_gate only for all fan-in or any-at-idle delivery.',
    promptGuidelines: delegatePromptGuidelines(cwd, promptConfig),
    parameters: DelegateParamsSchema,
    renderCall: renderDelegateCall,
    renderResult: renderDelegateResult,

    async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = normalizeModelParams(rawParams);
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

      // Capture ownership before any preparation can await or tree navigation
      // can move the active session branch.
      const launchSessionId = ctx.sessionManager.getSessionId();
      const launchBranchId = backgroundRuntime?.getBranchId?.();
      const runCtx = {
        pi,
        ctx,
        config,
        signal,
        getSnapshot,
        launchSessionId,
        launchBranchId,
        serviceTier: codexServiceTier(ctx),
        isLaunchBranchActive: () =>
          launchBranchId !== undefined &&
          backgroundRuntime?.getBranchId?.() === launchBranchId,
      };
      const activeWorkflow =
        backgroundRuntime?.getWorkflow?.() ?? backgroundRuntime?.workflow;
      const activeStatuses =
        backgroundRuntime?.getStatuses?.() ?? backgroundRuntime?.statuses;
      // Legacy batch payloads and calls without a logical id stay behind this
      // boundary. A new id/continue call treats background as a no-op and
      // always uses the coordinator.
      const legacySurface =
        Array.isArray((rawParams as { tasks?: unknown }).tasks) ||
        (params.id === undefined && params.continue === undefined);
      if (activeWorkflow && activeStatuses && !legacySurface) {
        if (Array.isArray(params.tasks))
          throw new Error(
            'A delegate call schedules one logical node at a time.',
          );
        const task = params.task?.trim();
        if (!task) throw new Error('Delegate task is required.');
        const continuationReference = params.continue?.trim();
        const symbolicBranchSource =
          params.inputs?.some((input) => input.include?.includes('branch')) ??
          false;
        if (continuationReference && params.id !== undefined)
          throw new Error(
            'Use either id for a fresh node or continue, not both.',
          );
        if (symbolicBranchSource)
          preflightSymbolicBranchRequest({
            continuation: Boolean(continuationReference),
            cwd: params.cwd,
            isolation: params.isolation,
            from: params.from,
            worktreePath: params.worktreePath,
            allowWrites: params.allowWrites,
          });
        const logicalId = continuationReference
          ? parseWorkflowReference(continuationReference).logicalId
          : params.id?.trim();
        if (!logicalId)
          throw new Error('Fresh delegate calls require a stable id.');
        if (continuationReference) {
          // These replacements are pure input policy. Reject them before the
          // coordinator admits a new lineage attempt; token, branch, and
          // worktree-dependent checks remain lazy until preparation opens.
          assertContinuationFields(
            continuationReference,
            params,
            'A continuation reuses its original cwd, context, base, and capabilities; scope may be replaced for this run.',
          );
          activeWorkflow.require(continuationReference);
        }
        const requestedRoute = params.route?.trim();
        const inheritedRouting = continuationReference
          ? activeWorkflow.getRouting(continuationReference)
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
        // The owner marker must precede branch-context snapshot capture, but
        // only after all pure model-facing validation has passed.
        backgroundRuntime?.ensureBranchOwner?.(ctx);
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
        if (symbolicBranchSource && initialPlan)
          initialPlan = preflightSymbolicBranchPlan(initialPlan);
        let capturedWip:
          | Awaited<ReturnType<typeof captureWorkInProgress>>
          | undefined;
        if (
          !continuationReference &&
          initialPlan &&
          initialPlan.isolation === 'worktree' &&
          initialPlan.worktreePath === undefined &&
          initialPlan.baseRef === undefined &&
          initialPlan.base !== 'head' &&
          !symbolicBranchSource
        ) {
          capturedWip = await captureWorkInProgress(initialPlan.requestedCwd, {
            signal,
          });
          initialPlan = {
            ...initialPlan,
            base: undefined,
            baseRef: capturedWip.ref,
          };
        }
        const releaseCapturedWip = async (): Promise<void> => {
          const source = capturedWip;
          capturedWip = undefined;
          if (source) await source.dispose();
        };
        if (signal?.aborted) {
          await releaseCapturedWip();
          throw (
            signal.reason ?? new Error('Delegate scheduling was cancelled.')
          );
        }
        const pending = createRun(task, routing, {
          name: params.name?.trim() || logicalId,
          context: continuationReference
            ? 'continuation'
            : (params.context ?? 'fresh'),
          allowWrites: params.allowWrites,
          writeRequested: params.allowWrites,
          capabilities: params.capabilities ? [...params.capabilities] : [],
          isolation: params.isolation,
        });
        let statusIds: string[] = [];
        let scheduled = false;
        try {
          statusIds = activeStatuses.start([pending], 'background');
          const attempt = activeWorkflow.schedule({
            logicalId,
            continuation: continuationReference,
            after: params.after,
            inputs: params.inputs as
              | import('./workflow-inputs').SymbolicWorkflowSelector[]
              | undefined,
            // Semantic calls derive display text from logicalId. Keep workflow
            // name absent so it cannot become a second persisted identity.
            ownerBranchId: launchBranchId,
            route: routing.route,
            routing,
            allowWrites: params.allowWrites,
            capabilities: params.capabilities
              ? [...params.capabilities]
              : undefined,
            ...(capturedWip ? { preparationCleanup: releaseCapturedWip } : {}),

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
                    if (statusId) activeStatuses.update(statusId, run);
                    if (run.worktree) backgroundRuntime?.activateBranches?.();
                  },
                },
              );
            },
          });
          scheduled = true;
          const statusId = statusIds[0];
          if (statusId) activeStatuses.setWorkflow(statusId, attempt);
          if (statusId && attempt.jobId)
            activeStatuses.setJobId(statusId, attempt.jobId);
          const updateTerminalStatus = (
            terminal: DelegateWorkflowAttemptSnapshot,
          ) => {
            if (!statusId) return;
            const run = activeWorkflow.getTerminalRun(terminal.identity);
            if (run) activeStatuses.update(statusId, run);
          };
          if (attempt.settledAt !== undefined) updateTerminalStatus(attempt);
          else {
            let unsubscribe: (() => void) | undefined;
            unsubscribe = activeWorkflow.subscribeTerminal((terminal) => {
              if (terminal.identity !== attempt.identity) return;
              updateTerminalStatus(terminal);
              unsubscribe?.();
            });
          }
          backgroundRuntime?.activateJobs?.();
          if (attempt.state === 'running' && statusId)
            activeStatuses.update(statusId, {
              ...pending,
              state: 'running',
              startedAt: attempt.startedAt,
            });
          return workflowReceipt(attempt) as unknown as {
            content: Array<{ type: 'text'; text: string }>;
            details: import('./types').LegacyDelegateDetails;
          };
        } catch (error) {
          if (!scheduled) await releaseCapturedWip().catch(() => undefined);
          activeStatuses.finish(statusIds);
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
      const statusIds = activeStatuses?.start(
        initialRuns,
        params.background ? 'background' : 'foreground',
      );

      if (params.background) {
        if (!backgroundRuntime)
          throw new Error('Background delegate runtime is unavailable.');
        const materializeHandoff = async (
          _materializeCtx: typeof ctx,
          runs: import('./types').DelegatedRun[],
          statusId?: string,
        ) => {
          const handoff = await buildOutputFileHandoff(runs);
          const publicRuns = runs.map((run) =>
            serializeDelegateRunForPublic(run),
          );
          if (statusId && publicRuns[0])
            activeStatuses?.update(statusId, publicRuns[0]);
          return { runs: publicRuns, retainedRuns: runs, handoff };
        };
        const controls = execution.tasks.map((item, index) => {
          const control = createDelegateControlChannel(
            item.session.filePath,
            launchSessionId,
            'background',
            item.runId,
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
                ownerBranchId: launchBranchId,
                mode: 'single' as const,
                tasks: [item.plan.task],
                deliveryEpoch: backgroundRuntime.getDeliveryEpoch(),
                route: item.plan.routing?.route,
                allowWrites: item.allowWrites,
                capabilities: item.capabilities
                  ? [...item.capabilities]
                  : undefined,
                feedback: (message) => control.enqueue('feedback', message),
                detachOnTeardown: true,
                execute: async (jobSignal, detachSignal) => {
                  try {
                    const runs = await runPreparedDelegateExecution(
                      { ...runCtx, signal: jobSignal },
                      { mode: 'single', tasks: [item] },
                      {
                        control,
                        hosted: true,
                        detachSignal,
                        onRunUpdate: (run) => {
                          if (statusIds?.[index])
                            activeStatuses?.update(statusIds[index], run);
                        },
                      },
                    );
                    // The child is settled before output-file and handoff
                    // materialization; reject feedback during that recovery
                    // window rather than reporting it as delivered.
                    if (detachSignal?.aborted) control.detach();
                    else control.close();
                    const run = runs[0];
                    if (run && statusIds?.[index])
                      activeStatuses?.update(statusIds[index], run);
                    return materializeHandoff(ctx, runs, statusIds?.[index]);
                  } finally {
                    if (detachSignal?.aborted) control.detach();
                    else control.close();
                  }
                },
                materialize: (materializeCtx, runs) =>
                  materializeHandoff(materializeCtx, runs, statusIds?.[index]),
              };
            }),
          );
        } catch (error) {
          for (const control of controls) control.close();
          if (statusIds) activeStatuses?.finish(statusIds);
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
            activeStatuses?.setJobId(statusIds[index], jobs[index].id);
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
            if (statusId) activeStatuses?.update(statusId, run);
          },
          onUpdate,
        });
      } catch (error) {
        if (statusIds) activeStatuses?.finish(statusIds);
        throw error;
      } finally {
        for (const control of controls) control.close();
      }
      if (runs.some((run) => run.worktree))
        backgroundRuntime?.activateBranches?.();
      const result = await delegateToolResult(pi, ctx, execution.mode, runs);
      if (statusIds) {
        // delegateToolResult publishes lifecycle diagnostics before returning;
        // refresh terminal status with that owner-safe projection rather than
        // leaving live status at its pre-materialization view.
        activeStatuses?.updateMany(statusIds, runs);
        activeStatuses?.resultEntered(statusIds);
      }
      return result;
    },
  });
}
