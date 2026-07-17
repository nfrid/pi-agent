import * as path from 'node:path';
import { StringEnum } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { artifactProducer } from '../artifacts';
import { loadDelegateConfig, resolveDelegateRoute } from './config';
import {
  applyIsolationPatch,
  attachIsolationSession,
  captureIsolationPatch,
  type DependencyMode,
  discardIsolation,
  failIsolationRun,
  type IsolationRecord,
  isolationPatchBytes,
  isolationValidationCommand,
  isolationValidationScript,
  listIsolations,
  loadIsolation,
  markIsolationRunning,
  type PreparedIsolation,
  prepareWritableIsolation,
  restoreIsolationSession,
  scrubStaleIsolationCredentials,
  validateIsolationCommand,
  validateIsolationPatch,
} from './isolation';
import { buildParentHandoff } from './output';
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
  type DelegateDetails,
  type DelegatedRun,
  type DelegateRouteState,
  getExactFinalAssistantText,
  getRunState,
  isRunError,
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

function makeDetails(
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
): DelegateDetails {
  return { mode, runs };
}

export async function buildArtifactBackedHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runs: DelegatedRun[],
  put = artifactProducer.put,
): Promise<string> {
  let handoff = buildParentHandoff(runs);
  const failedRuns = new Set<DelegatedRun>();
  // Artifact only the final assistant bytes that parent handoff caps or
  // normalization actually omit. Child sessions and run messages remain authoritative.
  for (let pass = 0; pass < runs.length; pass++) {
    let changed = false;
    for (const run of runs) {
      if (run.artifact || failedRuns.has(run)) continue;
      const exact = getExactFinalAssistantText(run.messages);
      if (!exact || handoff.includes(exact)) continue;
      try {
        run.artifact = await put(pi, ctx, {
          bytes: exact,
          producer: 'delegate',
          contentClass: 'delegate-output',
          mediaType: 'text/plain; charset=utf-8',
          creationSource: 'delegate.result',
        });
        changed = true;
      } catch {
        // Artifact policy/filesystem/size failures must not change child outcome.
        run.warnings = [
          ...(run.warnings ?? []),
          'Exact output artifact unavailable; child session remains authoritative.',
        ];
        failedRuns.add(run);
        changed = true;
      }
    }
    if (!changed) break;
    handoff = buildParentHandoff(runs);
  }
  return handoff;
}

function invalidParams(message: string): never {
  throw new Error(message);
}

async function finalizeIsolatedRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: DelegatedRun,
  isolation: PreparedIsolation | undefined,
): Promise<void> {
  if (!isolation) return;
  const state = getRunState(run);
  let record: IsolationRecord;
  try {
    record = await captureIsolationPatch(isolation.record.id, {
      outcome:
        state === 'success' ||
        state === 'error' ||
        state === 'aborted' ||
        state === 'timed-out'
          ? state
          : 'unknown',
    });
  } catch (error) {
    record = await failIsolationRun(isolation.record.id, error).catch(
      () => isolation.record,
    );
    run.state = 'error';
    run.stopReason = 'error';
    run.errorMessage = `Isolated delegate finalization failed: ${error instanceof Error ? error.message : String(error)}`;
    run.warnings = [
      ...(run.warnings ?? []),
      'The worktree was retained for diagnosis and is not eligible for application.',
    ];
  }
  const patch = record.patch;
  let handle: string | undefined;
  const bytes = isolationPatchBytes(record);
  if (patch && bytes && bytes.length > 0) {
    try {
      const artifact = await artifactProducer.put(pi, ctx, {
        bytes,
        producer: 'delegate',
        contentClass: 'tool-output',
        mediaType: 'text/x-diff; charset=utf-8',
        creationSource: 'delegate.patch',
        itemCount: patch.changedPaths.length,
      });
      handle = artifact.handle;
    } catch {
      run.warnings = [
        ...(run.warnings ?? []),
        'Exact patch artifact unavailable; the retained isolated worktree remains authoritative.',
      ];
    }
  }
  run.isolation = {
    id: record.id,
    backend: record.backend,
    repositoryRoot: record.repositoryRoot,
    worktreePath: record.worktreePath,
    workingDirectory: record.workingDirectory,
    baseHead: record.baseHead,
    dependencyMode: record.dependencyMode,
    runOutcome: record.runOutcome,
    validation: record.validation,
    status: record.status,
    ...(patch
      ? {
          patch: {
            ...(handle ? { handle } : {}),
            ...patch,
          },
        }
      : {}),
  };
  if (patch && !patch.diffCheckPassed)
    run.warnings = [
      ...(run.warnings ?? []),
      'Patch failed diff validation and is not eligible for application.',
    ];
  if (patch?.requiresIsolatedDependencyValidation)
    run.warnings = [
      ...(run.warnings ?? []),
      'Dependency manifests changed; application is blocked until isolated dependency validation is recorded.',
    ];
}

function routingFor(
  requested: unknown,
  config: ReturnType<typeof loadDelegateConfig>,
): { routing?: DelegateRouteState; error?: string } {
  return resolveDelegateRoute(requested, config);
}

export function mergeDelegateRouteRequest(
  requested: unknown,
  persisted?: DelegateRouteState,
): unknown {
  return requested ?? persisted?.route;
}

function persistSessionRoute(
  session: NonNullable<ReturnType<typeof resolveDelegateSession>>,
  routing: DelegateRouteState,
) {
  const updated = updateDelegateSessionRouting(session.token, routing);
  if (!updated)
    throw new Error('Could not persist the continuation route override.');
  return updated;
}

function normalizedScopes(cwd: string, scopes: string[]): string[] {
  return scopes.map((scope) => path.resolve(cwd, scope));
}

function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((left) =>
    b.some(
      (right) =>
        left === right ||
        left.startsWith(`${right}${path.sep}`) ||
        right.startsWith(`${left}${path.sep}`),
    ),
  );
}

function writeWarnings(
  cwds: string[],
  writeModes: boolean[],
  scopes: Array<string[] | undefined>,
): string[][] {
  const warnings = scopes.map(() => [] as string[]);
  for (let i = 0; i < scopes.length; i++) {
    if (!writeModes[i]) continue;
    for (let j = i + 1; j < scopes.length; j++) {
      if (!writeModes[j] || path.resolve(cwds[i]) !== path.resolve(cwds[j]))
        continue;
      const left = scopes[i]?.filter(Boolean) ?? [];
      const right = scopes[j]?.filter(Boolean) ?? [];
      const warning =
        left.length === 0 || right.length === 0
          ? `Parallel write tasks ${i + 1} and ${j + 1} share a working directory and at least one has no declared scope; coordinate changes carefully.`
          : scopesOverlap(
                normalizedScopes(cwds[i], left),
                normalizedScopes(cwds[j], right),
              )
            ? `Parallel write tasks ${i + 1} and ${j + 1} have overlapping declared scopes; coordinate changes carefully.`
            : undefined;
      if (warning) {
        warnings[i].push(warning);
        warnings[j].push(warning);
      }
    }
  }
  return warnings;
}

export default function delegate(pi: ExtensionAPI) {
  scrubStaleIsolationCredentials();
  if (process.env.PI_DELEGATE_CHILD === '1') return;

  pi.on('tool_result', (event) => {
    if (event.toolName !== 'delegate') return;
    const details = event.details as DelegateDetails | undefined;
    if (
      details?.runs?.length &&
      details.runs.every((run) => run.exitCode !== -1 && isRunError(run))
    )
      return { isError: true };
  });

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
        let session: NonNullable<ReturnType<typeof resolveDelegateSession>>;
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
          if (isolation && !resumed)
            await discardIsolation(isolation.record.id).catch(() => undefined);
          return invalidParams(
            `Delegate setup failed before launch: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (isolation)
          isolation = {
            ...isolation,
            record: await markIsolationRunning(isolation.record.id),
          };
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
        await finalizeIsolatedRun(pi, ctx, run, isolation);
        const runs = [run];
        const handoff = await buildArtifactBackedHandoff(pi, ctx, runs);
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
      const freshIsolationIds: string[] = [];
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
              freshIsolationIds.push(prepared.isolation.record.id);
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
          if (isolations[index] && !resumed[index])
            isolations[index] = attachIsolationSession(
              isolations[index] as PreparedIsolation,
              session.token,
              session.filePath,
            );
          sessions.push(session);
        }
      } catch (error) {
        await Promise.allSettled(
          freshIsolationIds.map((id) => discardIsolation(id)),
        );
        return invalidParams(
          `Parallel delegate setup failed before launch: ${error instanceof Error ? error.message : String(error)}`,
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
      const runs = await mapWithConcurrency(
        tasks,
        config.maxConcurrency,
        async (item, index) => {
          if (isolations[index])
            isolations[index] = {
              ...(isolations[index] as PreparedIsolation),
              record: await markIsolationRunning(
                (isolations[index] as PreparedIsolation).record.id,
              ),
            };
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
                liveRuns[index] = { ...current, warnings: warnings[index] };
              emit();
            },
            makeDetails: (items) => makeDetails('parallel', items),
          });
          run.warnings = [...(run.warnings ?? []), ...warnings[index]];
          await finalizeIsolatedRun(pi, ctx, run, isolations[index]);
          liveRuns[index] = run;
          emit();
          return run;
        },
      );
      const handoff = await buildArtifactBackedHandoff(pi, ctx, runs);
      return {
        content: [{ type: 'text' as const, text: handoff }],
        details: makeDetails('parallel', runs),
      };
    },
  });

  pi.registerCommand('delegate-patch', {
    description:
      'List, inspect, preview, validate, manually apply, or discard isolated delegate worktrees and patches',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const identifier = tokens[0];
      const action = tokens[1] ?? 'show';
      const validationArgs = tokens.slice(2);
      const validationScript = validationArgs[0];
      if (identifier === 'list') {
        const records = listIsolations();
        ctx.ui.notify(
          records.length
            ? records
                .map(
                  (item) =>
                    `${item.id}  ${item.status}  ${item.patch?.changedPaths.length ?? 0} path(s)  ${item.repositoryRoot}`,
                )
                .join('\n')
            : 'No retained delegate worktrees.',
          'info',
        );
        return;
      }
      if (!identifier) {
        ctx.ui.notify(
          'Usage: /delegate-patch list | <continuation-token|isolation-id> [show|diff|validate <package-script>|validate-command <executable> [args...]|apply|discard]',
          'error',
        );
        return;
      }
      const session = resolveDelegateSession(identifier);
      const id = session?.isolationId ?? identifier;
      const record = loadIsolation(id);
      if (!record) {
        ctx.ui.notify('Isolated delegate record not found.', 'error');
        return;
      }
      if (action === 'show') {
        const patch = record.patch;
        ctx.ui.notify(
          [
            `Isolation ${record.id}: ${record.status}`,
            `Repository: ${record.repositoryRoot}`,
            `Base: ${record.baseHead}`,
            `Worktree: ${record.worktreePath}`,
            `Scopes: ${record.requestedScopes.join(', ')}`,
            `Dependencies: ${record.dependencyMode}`,
            `Patch: ${patch ? `${patch.changedPaths.length} path(s), ${patch.size} bytes, sha256 ${patch.sha256}` : '(none)'}`,
            ...(patch?.unsafeReason
              ? [`Patch rejection: ${patch.unsafeReason}`]
              : []),
            `Run outcome: ${record.runOutcome ?? 'unknown'}`,
            `Validation: ${record.validation?.status ?? 'not-run'}${record.validation?.script ? ` (${record.validation.script})` : ''}`,
            ...(patch?.changedPaths ?? []).map((name) => `- ${name}`),
          ].join('\n'),
          'info',
        );
        return;
      }
      if (action === 'diff') {
        const bytes = isolationPatchBytes(record);
        if (!bytes) {
          ctx.ui.notify('Exact patch bytes are unavailable.', 'error');
          return;
        }
        const text = bytes.toString('utf8');
        const limit = 16 * 1024;
        ctx.ui.notify(
          `Patch sha256 ${record.patch?.sha256}\n\n${text.length > limit ? `${text.slice(0, limit)}\n\n[Preview truncated; exact patch remains retained.]` : text}`,
          'info',
        );
        return;
      }
      if (
        action !== 'validate' &&
        action !== 'validate-command' &&
        action !== 'apply' &&
        action !== 'discard'
      ) {
        ctx.ui.notify(
          'Action must be show, diff, validate, validate-command, apply, or discard.',
          'error',
        );
        return;
      }
      if (
        (action === 'validate' || action === 'validate-command') &&
        !validationScript
      ) {
        ctx.ui.notify(
          action === 'validate'
            ? 'Validation requires a package script name.'
            : 'Command validation requires an executable and optional arguments.',
          'error',
        );
        return;
      }
      if (!ctx.hasUI) {
        console.error('Patch mutation requires an interactive confirmation.');
        return;
      }
      let validationDefinition:
        | { definition: string; sha256: string }
        | undefined;
      if (action === 'validate' || action === 'validate-command') {
        try {
          validationDefinition =
            action === 'validate'
              ? isolationValidationScript(record.id, validationScript as string)
              : isolationValidationCommand(record.id, validationArgs);
        } catch (error) {
          ctx.ui.notify(
            `Validation script rejected: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
          return;
        }
      }
      const confirmed = await ctx.ui.confirm(
        action === 'validate' || action === 'validate-command'
          ? 'Run controlled isolated validation?'
          : action === 'apply'
            ? 'Apply isolated patch?'
            : 'Discard isolation?',
        action === 'validate' || action === 'validate-command'
          ? `Run ${action === 'validate' ? `package script ${validationScript}` : 'exact command argv'} in the isolated worktree? Exact definition (sha256 ${validationDefinition?.sha256}):\n\n${validationDefinition?.definition}\n\nNetwork is denied, the environment is minimal, and any patch change invalidates validation.`
          : action === 'apply'
            ? `Apply ${record.patch?.changedPaths.length ?? 0} changed path(s) to ${record.repositoryRoot}? The broker will revalidate the clean base, successful run, and validation evidence first.`
            : `Remove retained worktree ${record.id}? Exact artifact/session evidence is retained separately.`,
      );
      if (!confirmed) return;
      try {
        if (action === 'validate' || action === 'validate-command') {
          const validated =
            action === 'validate'
              ? await validateIsolationPatch(
                  record.id,
                  validationScript as string,
                  validationDefinition?.sha256 as string,
                )
              : await validateIsolationCommand(
                  record.id,
                  validationArgs,
                  validationDefinition?.sha256 as string,
                );
          ctx.ui.notify(
            `Validation ${validated.validation?.status ?? 'failed'} for ${validated.id}${validated.validation?.reason ? `: ${validated.validation.reason}` : '.'}`,
            validated.validation?.status === 'passed' ? 'info' : 'error',
          );
        } else if (action === 'apply') {
          const applied = await applyIsolationPatch(record.id);
          ctx.ui.notify(
            `Applied isolated patch ${applied.id}. Use /delegate-patch ${applied.id} discard to remove the retained worktree after review.`,
            'info',
          );
        } else {
          await discardIsolation(record.id);
          ctx.ui.notify(`Discarded isolation ${record.id}.`, 'info');
        }
      } catch (error) {
        ctx.ui.notify(
          `Patch broker rejected ${action}: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });
}
