import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type Static, Type } from 'typebox';
import { loadDelegateConfig } from './config';
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
import { rollbackPreparedDelegateTasks } from './task-lifecycle';
import {
  buildArtifactBackedHandoff,
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
    'Paths where work is expected. Read-only tasks treat these as guidance; writable tasks require existing paths and enforce them as OS-sandbox boundaries.',
});
const DependencySchema = StringEnum(['auto', 'link', 'isolated'] as const, {
  description:
    'Writable worktree dependency mode. auto safely links unchanged dependencies read-only when supported; isolated never reuses them.',
});
const AllowWritesSchema = Type.Boolean({
  description:
    'Request worktree-isolated edits. Fresh tasks require existing scope paths; continuations must set allowWrites to true again and reuse their original isolation. The returned patch is not applied automatically.',
});
const BackgroundSchema = Type.Boolean({
  description:
    'Run asynchronously and return a job ID immediately after setup. Completion is delivered automatically.',
});

const NameSchema = Type.String({
  minLength: 1,
  maxLength: 120,
  description:
    'Short human-readable subagent name shown in status UI, such as "Phase 5 review" or "Audit for regressions".',
});

const TaskItem = Type.Object({
  name: NameSchema,
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
  dependencies: Type.Optional(DependencySchema),
});

const DelegateParamsSchema = Type.Object({
  name: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 120,
      description:
        'Required with task. Short human-readable subagent name shown in status UI.',
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
  dependencies: Type.Optional(DependencySchema),
  background: Type.Optional(BackgroundSchema),
});

export type DelegateParams = Static<typeof DelegateParamsSchema>;

export function delegatePromptGuidelines(cwd: string): string[] {
  return [
    'Give every subagent a short, specific name that describes its role or phase.',
    'Prefer direct tools for small work. Do not invent research/implementation/test/review stages unless each adds concrete value.',
    'Use contextNote for the relevant decisions, constraints, and findings; use branch only when exact parent history matters.',
    'Continue a child for focused correction or extension; start fresh when its approach is wrong or an independent view is better.',
    "Parallelize only independent work. If one task depends on another's findings, inspect the first result before starting the next. Use background delegation only when foreground work can continue independently; completion is delivered automatically, so do not poll delegate_jobs. Writable tasks need non-overlapping scopes and return unapplied patches for parent review.",
    'After a writable run, report the isolation ID and walk the user through /delegate-patch <id> show, diff, validate <script> or validate-command <argv...>, apply, and discard. Never imply the patch was applied automatically.',
    'Treat child results as claims to verify: trust reported checks and concrete evidence; re-check or continue the child when important claims lack support.',
    'Delegate cannot be called by child processes.',
    `Delegate route catalog:\n${formatDelegateRoutingPrompt(cwd)}`,
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
): void {
  pi.registerTool({
    name: 'delegate',
    label: 'Delegate',
    description:
      'Delegate work to child Pi processes with isolated context. Fresh tasks need one exact catalog route; continuations reuse their persisted route when omitted. Routes respect maxRelativeCost. Writable tasks require scope and run in an isolated worktree sandbox; otherwise they are read-only. Set background true for independent work that should complete asynchronously.',
    promptSnippet:
      'Delegate substantial exploration, review, validation, implementation, or independent parallel work when a child would save context.',
    promptGuidelines: delegatePromptGuidelines(cwd),
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

      const runCtx = { pi, ctx, config, signal, getSnapshot };
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
        let jobs: ReturnType<DelegateJobManager['startMany']>;
        try {
          jobs = backgroundRuntime.manager.startMany(
            execution.tasks.map((item, index) => ({
              name: item.plan.name,
              mode: 'single' as const,
              tasks: [item.plan.task],
              deliveryEpoch: backgroundRuntime.getDeliveryEpoch(),
              route: item.plan.routing?.route,
              allowWrites: item.allowWrites,
              execute: async (jobSignal) => {
                try {
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
                  return {
                    runs,
                    handoff: await buildArtifactBackedHandoff(pi, ctx, runs),
                  };
                } finally {
                  if (statusIds?.[index])
                    backgroundRuntime.statuses.finish([statusIds[index]]);
                }
              },
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
              text: `Started ${jobs.length} background delegate ${jobs.length === 1 ? 'job' : 'jobs'}: ${jobs.map((job) => job.id).join(', ')}. Each subagent completion will be delivered automatically; use delegate_jobs peek to wait or inspect.\n${jobLines.join('\n')}`.trim(),
            },
          ],
          details: makeDetails(execution.mode, initialRuns),
        };
      }

      try {
        const runs = await runPreparedDelegateExecution(runCtx, execution, {
          onUpdate: (partial) => {
            if (statusIds)
              backgroundRuntime?.statuses.updateMany(
                statusIds,
                partial.details?.runs ?? [],
              );
            onUpdate?.(partial);
          },
        });
        return delegateToolResult(pi, ctx, execution.mode, runs);
      } finally {
        if (statusIds) backgroundRuntime?.statuses.finish(statusIds);
      }
    },
  });
}
