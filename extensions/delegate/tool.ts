import * as path from 'node:path';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { loadDelegateConfig } from './config';
import {
  attachIsolationSession,
  type DependencyMode,
  loadIsolation,
  markIsolationRunning,
  type PreparedIsolation,
  prepareWritableIsolation,
  restoreIsolationSession,
} from './isolation';
import { renderDelegateCall, renderDelegateResult } from './render';
import { mapWithConcurrency, runDelegate } from './runner';
import {
  buildSessionSnapshotJsonl,
  createDelegateSession,
  resolveDelegateSession,
  updateDelegateSessionRouting,
} from './session';
import {
  createRun,
  type DelegatedRun,
  type DelegateIsolationState,
  type DelegateRouteState,
} from './types';

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

import {
  assertDistinctContinuationTokens,
  buildArtifactBackedHandoff,
  discardFreshIsolation,
  failedLifecycleRun,
  finalizeIsolatedRun,
  invalidParams,
  isolationDetails,
  makeDetails,
  markLifecycleFailure,
  mergeDelegateRouteRequest,
  persistSessionRoute,
  removeSessionSafely,
  routingFor,
  throwIfAllRunsFailed,
  writeWarnings,
} from './supervision';

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
        const resolvedRoute = routingFor(
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
        const writeRequested = params.allowWrites ?? false;
        let allowWrites = false;
        let isolation: PreparedIsolation | undefined;
        const warnings: string[] = [];
        let effectiveCwd = requestedCwd;
        let scope = params.scope;
        if (resumed?.isolationId) {
          const record = loadIsolation(resumed.isolationId);
          if (!record)
            return invalidParams(
              'The isolated worktree for this continuation is unavailable.',
            );
          isolation = restoreIsolationSession(
            record,
            resumed.token,
            resumed.filePath,
          );
          effectiveCwd = path.join(
            isolation.record.worktreePath,
            isolation.record.workingDirectory,
          );
          scope = isolation.record.requestedScopes;
          allowWrites = writeRequested;
        } else if (writeRequested && resumed) {
          warnings.push(
            'This continuation was created read-only and cannot be elevated; running read-only.',
          );
        } else if (writeRequested) {
          const prepared = await prepareWritableIsolation({
            cwd: requestedCwd,
            scopes: params.scope ?? [],
            dependencyMode: params.dependencies as DependencyMode | undefined,
          });
          isolation = prepared.isolation;
          if (isolation) {
            effectiveCwd = path.join(
              isolation.record.worktreePath,
              isolation.record.workingDirectory,
            );
            allowWrites = true;
          } else if (prepared.fallbackReason)
            warnings.push(prepared.fallbackReason);
        }
        let session:
          | NonNullable<ReturnType<typeof resolveDelegateSession>>
          | undefined;
        const routeChanged = Boolean(
          resumed && params.route !== undefined && resolvedRoute.routing,
        );
        try {
          session = resumed
            ? params.route !== undefined && resolvedRoute.routing
              ? persistSessionRoute(resumed, resolvedRoute.routing)
              : resumed
            : createDelegateSession({
                cwd: effectiveCwd,
                snapshotJsonl: snapshot ?? undefined,
                isolationId: isolation?.record.id,
                routing: resolvedRoute.routing,
              });
          if (isolation && !resumed)
            isolation = attachIsolationSession(
              isolation,
              session.token,
              session.filePath,
            );
        } catch (error) {
          const cleanupWarnings: string[] = [];
          if (!resumed && session) {
            const warning = removeSessionSafely(session);
            if (warning) cleanupWarnings.push(warning);
          }
          if (resumed && routeChanged) {
            try {
              updateDelegateSessionRouting(resumed.token, resumed.routing);
            } catch (rollbackError) {
              cleanupWarnings.push(
                `Delegate route rollback failed for ${resumed.token}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              );
            }
          }
          if (isolation && !resumed) {
            const cleanup = await discardFreshIsolation(isolation);
            if (cleanup.warning) cleanupWarnings.push(cleanup.warning);
          }
          return invalidParams(
            `Delegate setup failed before launch: ${error instanceof Error ? error.message : String(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
          );
        }
        if (!session) return invalidParams('Delegate session setup failed.');
        if (isolation) {
          try {
            isolation = {
              ...isolation,
              record: await markIsolationRunning(isolation.record.id),
            };
          } catch (error) {
            const cleanupWarnings: string[] = [];
            let retainedIsolation: DelegateIsolationState | undefined;
            if (!resumed) {
              const sessionWarning = removeSessionSafely(session);
              if (sessionWarning) cleanupWarnings.push(sessionWarning);
              const cleanup = await discardFreshIsolation(isolation);
              if (cleanup.warning) cleanupWarnings.push(cleanup.warning);
              retainedIsolation = cleanup.details;
            } else {
              retainedIsolation = isolationDetails(
                loadIsolation(isolation.record.id) ?? isolation.record,
              );
            }
            const failed = failedLifecycleRun(
              params.task.trim(),
              resolvedRoute.routing,
              {
                cwd: effectiveCwd,
                context,
                contextNote: params.contextNote,
                scope,
                writeRequested,
                allowWrites,
                ...(resumed ? { continuation: session.token } : {}),
                warnings: [...warnings, ...cleanupWarnings],
              },
              error,
            );
            failed.isolation = retainedIsolation;
            const runs = [failed];
            const handoff = await buildArtifactBackedHandoff(pi, ctx, runs);
            throwIfAllRunsFailed(runs, handoff);
            return {
              content: [{ type: 'text' as const, text: handoff }],
              details: makeDetails('single', runs),
            };
          }
        }
        const run = await runDelegate({
          cwd: effectiveCwd,
          task: params.task.trim(),
          context,
          sessionPath: session.filePath,
          continuation: session.token,
          resuming: Boolean(resumed),
          contextNote: params.contextNote,
          scope,
          routing: resolvedRoute.routing,
          writeRequested,
          allowWrites,
          isolation,
          timeoutMs: config.timeoutMs,
          maxConcurrency: config.maxConcurrency,
          signal,
          onUpdate,
          makeDetails: (runs) => makeDetails('single', runs),
        });
        run.warnings = [...(run.warnings ?? []), ...warnings];
        try {
          await finalizeIsolatedRun(pi, ctx, run, isolation);
        } catch (error) {
          if (isolation) await markLifecycleFailure(run, isolation, error);
          else throw error;
        }
        const runs = [run];
        const handoff = await buildArtifactBackedHandoff(pi, ctx, runs);
        throwIfAllRunsFailed(runs, handoff);
        return {
          content: [{ type: 'text' as const, text: handoff }],
          details: makeDetails('single', runs),
        };
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
        return session;
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
        routingFor(
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
      const notes = tasks.map((item) => item.contextNote ?? params.contextNote);
      const scopes = tasks.map((item) => item.scope ?? params.scope);
      const writeRequests = tasks.map(
        (item) => item.allowWrites ?? params.allowWrites ?? false,
      );
      const warnings = writeWarnings(requestedCwds, writeRequests, scopes);
      for (let i = 0; i < tasks.length; i++) {
        if (
          !resumed[i] &&
          contexts[i] === 'branch' &&
          !getSnapshot(requestedCwds[i])
        )
          return invalidParams(
            'Cannot delegate: failed to snapshot current session branch.',
          );
      }
      const cwds = [...requestedCwds];
      const writes = writeRequests.map(() => false);
      const isolations: Array<PreparedIsolation | undefined> = tasks.map(
        () => undefined,
      );
      // Resolve every continuation before creating any fresh worktree so a bad
      // continuation cannot strand earlier preparations.
      for (let index = 0; index < tasks.length; index++) {
        const resumedSession = resumed[index];
        if (resumedSession?.isolationId) {
          const record = loadIsolation(resumedSession.isolationId);
          if (!record)
            return invalidParams(
              'The isolated worktree for a continuation is unavailable.',
            );
          isolations[index] = restoreIsolationSession(
            record,
            resumedSession.token,
            resumedSession.filePath,
          );
          cwds[index] = path.join(record.worktreePath, record.workingDirectory);
          scopes[index] = record.requestedScopes;
          writes[index] = writeRequests[index];
        } else if (writeRequests[index] && resumedSession) {
          warnings[index].push(
            'This continuation was created read-only and cannot be elevated; running read-only.',
          );
        }
      }
      const freshSessions: Array<
        NonNullable<ReturnType<typeof resolveDelegateSession>>
      > = [];
      const routeRollbacks: Array<{
        token: string;
        routing: DelegateRouteState | undefined;
      }> = [];
      const sessions = [] as Array<
        NonNullable<ReturnType<typeof resolveDelegateSession>>
      >;
      try {
        for (let index = 0; index < tasks.length; index++) {
          if (writeRequests[index] && !resumed[index]) {
            const prepared = await prepareWritableIsolation({
              cwd: requestedCwds[index],
              scopes: scopes[index] ?? [],
              dependencyMode: (tasks[index].dependencies ??
                params.dependencies) as DependencyMode | undefined,
            });
            if (prepared.isolation) {
              isolations[index] = prepared.isolation;
              cwds[index] = path.join(
                prepared.isolation.record.worktreePath,
                prepared.isolation.record.workingDirectory,
              );
              writes[index] = true;
            } else if (prepared.fallbackReason) {
              warnings[index].push(prepared.fallbackReason);
            }
          }
          const resumedSession = resumed[index];
          const requestedRoute = tasks[index].route ?? params.route;
          if (
            resumedSession &&
            requestedRoute !== undefined &&
            routings[index].routing
          )
            routeRollbacks.push({
              token: resumedSession.token,
              routing: resumedSession.routing,
            });
          const session = resumedSession
            ? requestedRoute !== undefined && routings[index].routing
              ? persistSessionRoute(
                  resumedSession,
                  routings[index].routing as DelegateRouteState,
                )
              : resumedSession
            : createDelegateSession({
                cwd: cwds[index],
                snapshotJsonl:
                  contexts[index] === 'branch'
                    ? (getSnapshot(requestedCwds[index]) ?? undefined)
                    : undefined,
                isolationId: isolations[index]?.record.id,
                routing: routings[index].routing,
              });
          if (!resumedSession) freshSessions.push(session);
          if (isolations[index] && !resumed[index])
            isolations[index] = attachIsolationSession(
              isolations[index] as PreparedIsolation,
              session.token,
              session.filePath,
            );
          sessions.push(session);
        }
      } catch (error) {
        const cleanupWarnings: string[] = [];
        for (const session of freshSessions) {
          const warning = removeSessionSafely(session);
          if (warning) cleanupWarnings.push(warning);
        }
        for (const rollback of routeRollbacks.reverse()) {
          try {
            updateDelegateSessionRouting(rollback.token, rollback.routing);
          } catch (rollbackError) {
            cleanupWarnings.push(
              `Delegate route rollback failed for ${rollback.token}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        for (let index = 0; index < isolations.length; index++) {
          const isolation = isolations[index];
          if (!isolation || resumed[index]) continue;
          const cleanup = await discardFreshIsolation(isolation);
          if (cleanup.warning) cleanupWarnings.push(cleanup.warning);
        }
        return invalidParams(
          `Parallel delegate setup failed before launch: ${error instanceof Error ? error.message : String(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
        );
      }
      const liveRuns = tasks.map((item, index) =>
        createRun(item.task, routings[index].routing, {
          cwd: cwds[index],
          context: contexts[index],
          contextNote: notes[index],
          scope: scopes[index],
          writeRequested: writeRequests[index],
          allowWrites: writes[index],
          continuation: sessions[index].token,
          warnings: warnings[index],
        }),
      );
      const warningText = [...new Set(warnings.flat())];
      const emit = () => {
        const done = liveRuns.filter((run) => run.exitCode !== -1).length;
        onUpdate?.({
          content: [
            {
              type: 'text',
              text: `${warningText.length ? `${warningText.map((w) => `Warning: ${w}`).join('\n')}\n\n` : ''}Delegated tasks: ${done}/${liveRuns.length} complete`,
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
          tasks,
          config.maxConcurrency,
          async (item, index) => {
            let markedRunning = false;
            try {
              if (isolations[index]) {
                isolations[index] = {
                  ...(isolations[index] as PreparedIsolation),
                  record: await markIsolationRunning(
                    (isolations[index] as PreparedIsolation).record.id,
                  ),
                };
                markedRunning = true;
                if (!resumed[index])
                  launchedFreshIsolationIds.add(
                    (isolations[index] as PreparedIsolation).record.id,
                  );
              }
              const run = await runDelegate({
                cwd: cwds[index],
                task: item.task,
                context: contexts[index],
                sessionPath: sessions[index].filePath,
                continuation: sessions[index].token,
                resuming: Boolean(resumed[index]),
                contextNote: notes[index],
                scope: scopes[index],
                routing: routings[index].routing,
                writeRequested: writeRequests[index],
                allowWrites: writes[index],
                isolation: isolations[index],
                timeoutMs: config.timeoutMs,
                maxConcurrency: config.maxConcurrency,
                signal,
                onUpdate: (partial) => {
                  const current = partial.details?.runs?.[0];
                  if (current)
                    liveRuns[index] = {
                      ...current,
                      warnings: warnings[index],
                    };
                  emit();
                },
                makeDetails: (items) => makeDetails('parallel', items),
              });
              run.warnings = [...(run.warnings ?? []), ...warnings[index]];
              await finalizeIsolatedRun(pi, ctx, run, isolations[index]);
              liveRuns[index] = run;
              emit();
              return run;
            } catch (error) {
              const isolation = isolations[index];
              const cleanupWarnings: string[] = [];
              let retainedIsolation: DelegateIsolationState | undefined;
              if (isolation && !markedRunning && !resumed[index]) {
                const sessionWarning = removeSessionSafely(sessions[index]);
                if (sessionWarning) cleanupWarnings.push(sessionWarning);
                const cleanup = await discardFreshIsolation(isolation);
                if (cleanup.warning) cleanupWarnings.push(cleanup.warning);
                retainedIsolation = cleanup.details;
              } else if (isolation && !markedRunning) {
                retainedIsolation = isolationDetails(
                  loadIsolation(isolation.record.id) ?? isolation.record,
                );
              }
              const failed = failedLifecycleRun(
                item.task,
                routings[index].routing,
                {
                  cwd: cwds[index],
                  context: contexts[index],
                  contextNote: notes[index],
                  scope: scopes[index],
                  writeRequested: writeRequests[index],
                  allowWrites: writes[index],
                  ...(!isolation || resumed[index] || markedRunning
                    ? { continuation: sessions[index].token }
                    : {}),
                  warnings: [...warnings[index], ...cleanupWarnings],
                },
                error,
              );
              if (isolation && markedRunning)
                await markLifecycleFailure(failed, isolation, error);
              else failed.isolation = retainedIsolation;
              liveRuns[index] = failed;
              emit();
              return failed;
            }
          },
        );
      } catch (error) {
        const cleanupWarnings: string[] = [];
        for (let index = 0; index < isolations.length; index++) {
          const isolation = isolations[index];
          if (
            !isolation ||
            resumed[index] ||
            launchedFreshIsolationIds.has(isolation.record.id)
          )
            continue;
          const sessionWarning = removeSessionSafely(sessions[index]);
          if (sessionWarning) cleanupWarnings.push(sessionWarning);
          const cleanup = await discardFreshIsolation(isolation);
          if (cleanup.warning) cleanupWarnings.push(cleanup.warning);
        }
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
        );
      }
      const handoff = await buildArtifactBackedHandoff(pi, ctx, runs);
      throwIfAllRunsFailed(runs, handoff);
      return {
        content: [{ type: 'text' as const, text: handoff }],
        details: makeDetails('parallel', runs),
      };
    },
  });
}
