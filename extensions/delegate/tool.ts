import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { loadDelegateConfig, resolveDelegateRoute } from './config';
import { loadIsolation } from './isolation';
import { renderDelegateCall, renderDelegateResult } from './render';
import { mapWithConcurrency } from './runner';
import { buildSessionSnapshotJsonl, resolveDelegateSession } from './session';
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
  type DelegateTaskPlan,
  type PreparedDelegateTask,
  preflightDelegateContinuation,
  prepareDelegateTask,
  rollbackPreparedDelegateTasks,
  runPreparedDelegateTask,
} from './task-lifecycle';
import { createRun, type DelegatedRun } from './types';

const RouteSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  description:
    'Exact route key from the user-owned delegate catalog. Required for fresh tasks; continuations reuse their persisted route when omitted.',
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
    'Request worktree-isolated edits. Fresh tasks require explicit existing scope paths; continuations must repeat true and reuse their original isolation. The returned patch is not applied automatically.',
});

const TaskItem = Type.Object({
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

const DelegateParams = Type.Object({
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
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerDelegateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'delegate',
    label: 'Delegate',
    description:
      'Delegate focused work to child Pi processes with isolated context windows. Fresh tasks require one exact user-owned catalog route; continuations reuse their persisted route when omitted. Routes are constrained by maxRelativeCost. Writable tasks require scope and run only in an isolated worktree with an OS-enforced sandbox; otherwise they fall back to read-only.',
    promptSnippet:
      'Delegate substantial focused exploration, review, validation, implementation, or independent parallel work when a child process would save context.',
    promptGuidelines: [
      'Prefer direct tools for small work. Select the lowest-cost catalog route whose relative intelligence and description fit the task; roles remain free-form in the task. Do not create research, implementation, test, or review stages unless each adds concrete value.',
      'Use contextNote to give a fresh child only the relevant decisions, constraints, and prior findings; use branch only when exact parent history matters.',
      'Continue a child when it already has useful task context and needs focused correction or extension; start fresh when its approach is unsuitable or an independent view is more valuable.',
      "Parallelize only independent work. When one task depends on another's findings, inspect the first result before starting or continuing the next; writable tasks require non-overlapping scope directories and produce unapplied patches for parent review.",
      'After a writable run, report the isolation ID and direct the user through /delegate-patch <id> show, diff, validate <script> or validate-command <argv...>, apply, and discard. Never imply that a child patch was applied automatically.',
      'Treat delegated results as evidence rather than authority: use reported checks and concrete evidence, and verify directly or continue the child when important claims remain unsupported.',
      'Delegate cannot be called by child processes.',
    ],
    parameters: DelegateParams,
    renderCall: renderDelegateCall,
    renderResult: renderDelegateResult,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadDelegateConfig(ctx.cwd);
      const snapshots = new Map<string, string | null>();
      const getSnapshot = (cwd: string) => {
        if (snapshots.has(cwd)) return snapshots.get(cwd) ?? null;
        const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager, {
          cwd,
          excludeToolCallId: toolCallId,
        });
        snapshots.set(cwd, snapshot);
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

      if (hasSingle && typeof params.task === 'string') {
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
          return invalidParams(
            'Unknown or expired delegate continuation token.',
          );
        const resolvedRoute = resolveDelegateRoute(
          mergeDelegateRouteRequest(params.route, resumed?.routing),
          config,
        );
        if (resolvedRoute.error) return invalidParams(resolvedRoute.error);
        const requestedCwd = resumed?.cwd ?? params.cwd ?? ctx.cwd;
        const context = resumed ? 'continuation' : (params.context ?? 'fresh');
        const snapshot =
          !resumed && context === 'branch'
            ? getSnapshot(requestedCwd)
            : undefined;
        if (!resumed && context === 'branch' && !snapshot)
          return invalidParams(
            'Cannot delegate: failed to snapshot current session branch.',
          );

        const plan: DelegateTaskPlan = {
          task: params.task.trim(),
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
        let preflight: ReturnType<typeof preflightDelegateContinuation>;
        try {
          preflight = preflightDelegateContinuation(plan);
        } catch (error) {
          return invalidParams(errorText(error));
        }
        let prepared: PreparedDelegateTask;
        try {
          prepared = await prepareDelegateTask(plan, preflight);
        } catch (error) {
          return invalidParams(
            `Delegate setup failed before launch: ${errorText(error)}`,
          );
        }

        let markedRunning = false;
        let run: DelegatedRun;
        try {
          run = await runPreparedDelegateTask(prepared, {
            timeoutMs: config.timeoutMs,
            maxConcurrency: config.maxConcurrency,
            signal,
            onUpdate,
            makeDetails: (runs) => makeDetails('single', runs),
            onIsolationRunning: () => {
              markedRunning = true;
            },
          });
        } catch (error) {
          if (!prepared.isolation || markedRunning) throw error;
          const cleanup = !resumed
            ? await cleanupFreshPreparedTask(prepared)
            : {
                warnings: [],
                isolation: isolationDetails(
                  loadIsolation(prepared.isolation.record.id) ??
                    prepared.isolation.record,
                ),
              };
          const failed = failedLifecycleRun(
            plan.task,
            plan.routing,
            {
              cwd: prepared.cwd,
              context: plan.context,
              contextNote: plan.contextNote,
              scope: prepared.scope,
              writeRequested: plan.writeRequested,
              allowWrites: prepared.allowWrites,
              ...(resumed ? { continuation: prepared.session.token } : {}),
              warnings: [...prepared.warnings, ...cleanup.warnings],
            },
            error,
          );
          failed.isolation = cleanup.isolation;
          return delegateToolResult(pi, ctx, 'single', [failed]);
        }

        try {
          await finalizeIsolatedRun(pi, ctx, run, prepared.isolation);
        } catch (error) {
          if (prepared.isolation)
            await markLifecycleFailure(run, prepared.isolation, error);
          else throw error;
        }
        return delegateToolResult(pi, ctx, 'single', [run]);
      }

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
          return invalidParams(
            'Unknown or expired delegate continuation token.',
          );
        return session ?? undefined;
      });
      assertDistinctContinuationTokens(
        resumed.map((session) => session?.token),
      );
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
        (item, index) =>
          resumed[index]?.cwd ?? item.cwd ?? params.cwd ?? ctx.cwd,
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

      const preflights = [] as ReturnType<
        typeof preflightDelegateContinuation
      >[];
      try {
        for (const plan of plans)
          preflights.push(preflightDelegateContinuation(plan));
      } catch (error) {
        return invalidParams(errorText(error));
      }

      const prepared: PreparedDelegateTask[] = [];
      try {
        for (let index = 0; index < plans.length; index++)
          prepared.push(
            await prepareDelegateTask(plans[index], preflights[index]),
          );
      } catch (error) {
        const cleanupWarnings = await rollbackPreparedDelegateTasks(prepared);
        return invalidParams(
          `Parallel delegate setup failed before launch: ${errorText(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
        );
      }

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
      const warningText = [
        ...new Set(prepared.flatMap((item) => item.warnings)),
      ];
      const emit = () => {
        const done = liveRuns.filter((run) => run.exitCode !== -1).length;
        onUpdate?.({
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
            let markedRunning = false;
            try {
              const run = await runPreparedDelegateTask(item, {
                timeoutMs: config.timeoutMs,
                maxConcurrency: config.maxConcurrency,
                signal,
                onUpdate: (partial) => {
                  const current = partial.details?.runs?.[0];
                  if (current)
                    liveRuns[index] = {
                      ...current,
                      warnings: item.warnings,
                    };
                  emit();
                },
                makeDetails: (items) => makeDetails('parallel', items),
                onIsolationRunning: (isolation) => {
                  markedRunning = true;
                  if (!item.plan.resumed)
                    launchedFreshIsolationIds.add(isolation.record.id);
                },
              });
              await finalizeIsolatedRun(pi, ctx, run, item.isolation);
              liveRuns[index] = run;
              emit();
              return run;
            } catch (error) {
              const cleanup =
                item.isolation && !markedRunning && !item.plan.resumed
                  ? await cleanupFreshPreparedTask(item)
                  : {
                      warnings: [],
                      isolation:
                        item.isolation && !markedRunning
                          ? isolationDetails(
                              loadIsolation(item.isolation.record.id) ??
                                item.isolation.record,
                            )
                          : undefined,
                    };
              const failed = failedLifecycleRun(
                item.plan.task,
                item.plan.routing,
                {
                  cwd: item.cwd,
                  context: item.plan.context,
                  contextNote: item.plan.contextNote,
                  scope: item.scope,
                  writeRequested: item.plan.writeRequested,
                  allowWrites: item.allowWrites,
                  ...(!item.isolation || item.plan.resumed || markedRunning
                    ? { continuation: item.session.token }
                    : {}),
                  warnings: [...item.warnings, ...cleanup.warnings],
                },
                error,
              );
              if (item.isolation && markedRunning)
                await markLifecycleFailure(failed, item.isolation, error);
              else failed.isolation = cleanup.isolation;
              liveRuns[index] = failed;
              emit();
              return failed;
            }
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
      return delegateToolResult(pi, ctx, 'parallel', runs);
    },
  });
}
