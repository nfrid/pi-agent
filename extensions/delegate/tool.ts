import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type Static, Type } from 'typebox';
import { type DelegateConfig, loadDelegateConfig } from './config';
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
    'Let a task edit files. This capability is independent from workspace isolation; continuations inherit it when omitted and cannot change it explicitly.',
});
const IsolationSchema = StringEnum(['shared', 'worktree'] as const, {
  description:
    'Workspace mode. Fresh read-only tasks default to shared and writable tasks to worktree. Read-only worktrees are supported; writable shared tasks are rejected. Continuations inherit this when omitted and cannot change it explicitly.',
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

const ResultSpecSchema = Type.Object(
  {
    schema: Type.Any({
      description:
        'Bounded JSON-schema subset for the complete machine-readable result',
    }),
    projection: Type.Optional(
      Type.Array(Type.String({ maxLength: 256 }), {
        maxItems: 32,
        description:
          'Static schema paths selected for the compact parent envelope',
      }),
    ),
    views: Type.Optional(
      Type.Record(
        Type.String({
          minLength: 1,
          maxLength: 64,
          pattern: '^[A-Za-z][A-Za-z0-9_-]*$',
        }),
        Type.String({ maxLength: 256 }),
        { maxProperties: 16 },
      ),
    ),
  },
  { additionalProperties: false },
);

export type DelegateHandoffFrom = Static<typeof HandoffArtifactSchema>;
export type DelegateHandoffInput = Static<typeof HandoffFromSchema>;
export type DelegateResultSpec = Static<typeof ResultSpecSchema>;

const BackgroundSchema = Type.Boolean({
  description:
    'Run asynchronously and return a job ID immediately after setup. Completion is delivered automatically.',
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
    'Give every subagent a short, specific name that describes its role or phase.',
    'Your context is the resource that runs out first; a child spends its own. Delegate — implementation and edits included, not only exploration and review — when the work needs more reading than its result is worth carrying, or when independent pieces can run at once. Do the work yourself when finishing it is quicker than briefing it, and do not invent research/implement/test/review stages that add nothing.',
    'Brief a writable task like a ticket: what done looks like, the command that proves it, and what to leave alone. A child that has to infer its finish line will pick one of its own.',
    'Isolation and write capability are separate: fresh read-only work defaults to the shared checkout, while writable work defaults to a worktree. Choose read-only worktree isolation for long audits when parent changes may overlap; after fixing audit findings, use a fresh isolated delegate to review those fixes.',
    'Own delegation deliberately: keep task decomposition, final decisions, and user-facing synthesis with yourself. Preserve parent context by forwarding only the decisions and evidence a child needs, not the whole conversation; use contextNote for relevant decisions, constraints, and findings, and use branch only when exact parent history matters. Small, tightly coupled work is often faster and safer to do yourself.',
    'Continue a read-only isolated child without refresh to revisit the same snapshot, or use refresh wip/head for targeted verification after fixes; a refreshed continuation preserves context but is not independent evidence. Start a fresh delegate for an independent regression review.',
    'A child that comes back with a "Blocked:" question is waiting on you, not failing. Answer it — from what you know, or by looking — and continue that child; re-briefing a fresh one throws away the context it already built. Decide it yourself unless it is genuinely the user\'s call.',
    "Parallelize only independent work: if one task depends on another's findings, inspect enough of the compact prerequisite envelope to confirm its outcome, relevant conclusion/evidence, assumptions, and risks; use handoffFrom only when exact upstream detail is needed. Worktree-isolated tasks each get their own checkout, so writable tasks can run in parallel even on overlapping files. Use background delegation when foreground work can continue meanwhile; use foreground delegation when the next parent action must await the result.",
    'A writable run leaves its work as commits on the branch it reports; integrate it yourself with delegate_branches rather than handing the merge to the user. A delegate-output artifact being available is not an instruction to retrieve it: use the compact envelope unless exact upstream wording would change a decision, and then use handoffFrom (or artifact retrieval) deliberately.',
    'For machine-readable work, provide result with a bounded schema, projection paths, and named static views. The child must finish through delegate_result; the full validated JSON stays in an owner-session artifact, while only selected projections enter the parent envelope. Use handoffFrom with {handle, view} to forward a named view without retrieving the full artifact into your context. Omit result for the exact legacy prose contract.',
    'Supervise proportionally: inspect and verify high-risk or consequential work, while letting routine bounded work return a compact report. Treat child results as claims to verify: trust reported checks and concrete evidence, and re-check or continue the child when an important claim has none. A subagent can report work it did not finish, and weakening a test is a common way a task comes back "passing".',
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
    description:
      'Delegate work to child Pi processes with their own context. Fresh tasks and fresh batch items require a name; continuations with persisted names may omit it. Fresh tasks need one exact catalog route; continuations reuse persisted route, write capability, and isolation when omitted. Fresh writable tasks default to an isolated git worktree; fresh read-only tasks default to the shared checkout, or may explicitly use a worktree snapshot. Writable shared tasks are rejected. Use result for a bounded machine-readable child contract, or omit it for legacy prose. Use handoffFrom with a prior delegate-output artifact handle; {handle, view} forwards only a registered named view and the bytes stay out of the parent-visible result. Set background true for independent work that should complete asynchronously.',
    promptSnippet:
      'Hand a child implementation, exploration, review, validation, or independent parallel work whenever a subagent would save your own context.',
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
          return {
            runs: ownerSession
              ? publicRuns
              : publicRuns.map((run) => ({ ...run, artifact: undefined })),
            retainedRuns: runs,
            handoff,
          };
        };
        let jobs: ReturnType<DelegateJobManager['startMany']>;
        try {
          jobs = backgroundRuntime.manager.startMany(
            execution.tasks.map((item, index) => ({
              name: item.plan.name,
              ownerSessionId: launchSessionId,
              mode: 'single' as const,
              tasks: [item.plan.task],
              deliveryEpoch: backgroundRuntime.getDeliveryEpoch(),
              route: item.plan.routing?.route,
              allowWrites: item.allowWrites,
              execute: async (jobSignal) => {
                const runs = await runPreparedDelegateExecution(
                  { ...runCtx, signal: jobSignal },
                  { mode: 'single', tasks: [item] },
                  {
                    onUpdate: (partial) => {
                      const run = partial.details?.runs?.[0];
                      if (run && statusIds?.[index])
                        backgroundRuntime.statuses.update(
                          statusIds[index],
                          run,
                        );
                    },
                  },
                );
                const run = runs[0];
                if (run && statusIds?.[index])
                  backgroundRuntime.statuses.update(statusIds[index], run);
                return materializeHandoff(ctx, runs);
              },
              materialize: materializeHandoff,
            })),
          );
        } catch (error) {
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
              text: `Started ${jobs.length} background delegate ${jobs.length === 1 ? 'job' : 'jobs'}: ${jobs.map((job) => job.id).join(', ')}. Each subagent completion will be delivered automatically. Continue independent work; if none remains, briefly tell the user you are waiting for the background delegate and will resume automatically, then end the turn. Use delegate_jobs peek only for deliberate inspection or a decision-changing bounded timeout.\n${jobLines.join('\n')}`.trim(),
            },
          ],
          details: makeDetails(execution.mode, initialRuns),
        };
      }

      let runs: Awaited<ReturnType<typeof runPreparedDelegateExecution>>;
      try {
        runs = await runPreparedDelegateExecution(runCtx, execution, {
          onUpdate: (partial) => {
            if (statusIds)
              backgroundRuntime?.statuses.updateMany(
                statusIds,
                partial.details?.runs ?? [],
              );
            onUpdate?.(partial);
          },
        });
      } catch (error) {
        if (statusIds) backgroundRuntime?.statuses.finish(statusIds);
        throw error;
      }
      if (statusIds) {
        backgroundRuntime?.statuses.updateMany(statusIds, runs);
        backgroundRuntime?.statuses.resultEntered(statusIds);
      }
      return delegateToolResult(pi, ctx, execution.mode, runs, launchSessionId);
    },
  });
}
