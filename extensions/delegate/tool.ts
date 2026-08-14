import { resolve } from 'node:path';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type Static, Type } from 'typebox';
import { loadGuidelines } from '../shared/instructions';
import { type DelegateConfig, loadDelegateConfig } from './config';
import { createDelegateControlChannel } from './control';
import type { DelegateJobManager } from './jobs';
import {
  pendingRuns,
  prepareDelegateExecution,
  runPreparedDelegateExecution,
} from './orchestration';
import { invalidParams } from './param-errors';
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

export const DELEGATE_TOOL_DESCRIPTION =
  'Run focused child agents with separate context. Choose a route, workspace mode, and either a prose or structured result contract; background completion is delivered automatically.';

const RouteSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  description:
    'Exact route key from the delegate catalog. Required for fresh tasks; continuations reuse their persisted route when omitted.',
});
const ContextSchema = StringEnum(['branch', 'fresh'] as const, {
  description:
    'Optional context mode. fresh starts with the task and project instructions; branch also includes parent conversation history.',
});
const ScopeSchema = Type.Array(Type.String({ maxLength: 4096 }), {
  maxItems: 100,
  description:
    'Paths where the work is expected to land. Guidance for the child, not a hard boundary.',
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
  Type.Array(Type.String({ maxLength: 256 }), {
    maxItems: 32,
    description: 'Static schema paths selected for the compact parent envelope',
  }),
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
const ResultSpecSchema = Type.Union([
  Type.Object(
    {
      schema: Type.Any({
        description:
          'Bounded JSON-schema subset for the complete machine-readable result',
      }),
      projection: ResultProjectionSchema,
      views: ResultViewsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      shape: Type.Any({
        description:
          'Compact result shape: primitive type tokens; required-by-default object fields; one-item arrays for homogeneous lists; multi-literal arrays for enums; exact {$optional: shape} wrappers; and $type descriptors for constraints',
      }),
      projection: ResultProjectionSchema,
      views: ResultViewsSchema,
    },
    { additionalProperties: false },
  ),
]);

export type DelegateHandoffFrom = Static<typeof HandoffArtifactSchema>;
export type DelegateHandoffInput = Static<typeof HandoffFromSchema>;
export type DelegateResultSpec = Static<typeof ResultSpecSchema>;

const BackgroundSchema = Type.Boolean({
  description:
    'Run asynchronously and return a job ID immediately; completion is delivered automatically.',
});

const NameSchema = Type.String({
  minLength: 1,
  maxLength: 120,
  description:
    'Required for fresh batch items; valid new-format continuation items inherit it when omitted. Short human-readable subagent name shown in status UI, such as "Phase 5 review" or "Audit for regressions".',
});

const TaskItem = Type.Object({
  name: Type.Optional(NameSchema),
  task: Type.String({
    minLength: 1,
    maxLength: 32 * 1024,
    description: 'Focused task or continuation feedback',
  }),
  cwd: Type.Optional(Type.String({ maxLength: 4096 })),
  route: Type.Optional(RouteSchema),
  context: Type.Optional(ContextSchema),
  contextNote: Type.Optional(
    Type.String({
      maxLength: 64 * 1024,
      description: 'Curated context from the parent agent',
    }),
  ),
  scope: Type.Optional(ScopeSchema),
  continuation: Type.Optional(
    Type.String({
      maxLength: 512,
      description: 'Opaque token from a previous delegate run',
    }),
  ),
  allowWrites: Type.Optional(AllowWritesSchema),
  isolation: Type.Optional(IsolationSchema),
  from: Type.Optional(BaseSchema),
  refresh: Type.Optional(RefreshSchema),
  worktreePath: Type.Optional(WorktreePathSchema),
  handoffFrom: Type.Optional(HandoffFromSchema),
  result: Type.Optional(ResultSpecSchema),
});

const DelegateParamsSchema = Type.Object({
  name: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 120,
      description:
        'Required for fresh tasks; valid new-format continuations inherit it when omitted. Short human-readable subagent name shown in status UI.',
    }),
  ),
  task: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 32 * 1024,
      description: 'Focused task or follow-up feedback',
    }),
  ),
  tasks: Type.Optional(Type.Array(TaskItem, { maxItems: 20 })),
  cwd: Type.Optional(Type.String({ maxLength: 4096 })),
  route: Type.Optional(RouteSchema),
  context: Type.Optional(ContextSchema),
  contextNote: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  scope: Type.Optional(ScopeSchema),
  continuation: Type.Optional(Type.String({ maxLength: 512 })),
  allowWrites: Type.Optional(AllowWritesSchema),
  isolation: Type.Optional(IsolationSchema),
  from: Type.Optional(BaseSchema),
  refresh: Type.Optional(RefreshSchema),
  worktreePath: Type.Optional(WorktreePathSchema),
  handoffFrom: Type.Optional(HandoffFromSchema),
  result: Type.Optional(ResultSpecSchema),
  background: Type.Optional(BackgroundSchema),
});

export type DelegateParams = Static<typeof DelegateParamsSchema>;

export function delegatePromptGuidelines(
  cwd: string,
  config?: DelegateConfig,
): string[] {
  return [
    // Parent workflow preferences belong to the delegate extension and are
    // validated as bullet-only guidelines at load time.
    ...loadGuidelines(
      'extensions/delegate/instructions.md',
      resolve(__dirname, '../..'),
    ),
    `Delegate route catalog:\n${formatDelegateRoutingPrompt(cwd, config)}`,
  ];
}

export interface DelegateBackgroundRuntime {
  manager: DelegateJobManager;
  statuses: DelegateStatusStore;
  getDeliveryEpoch: () => number;
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
      'Hand off focused implementation, review, validation, or independent work when a child saves your context.',
    promptGuidelines: delegatePromptGuidelines(cwd, promptConfig),
    parameters: DelegateParamsSchema,
    renderCall: renderDelegateCall,
    renderResult: renderDelegateResult,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
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

      const hasSingle =
        typeof params.task === 'string' && params.task.trim().length > 0;
      const hasParallel =
        Array.isArray(params.tasks) && params.tasks.length > 0;
      if (hasSingle === hasParallel)
        return invalidParams(
          'Provide exactly one delegation mode: task or tasks.',
        );

      const launchSessionId = ctx.sessionManager.getSessionId();
      const runCtx = {
        pi,
        ctx,
        config,
        signal,
        getSnapshot,
        launchSessionId,
      };
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
