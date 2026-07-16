import * as path from 'node:path';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type Static, Type } from 'typebox';
import { EFFORT_LEVELS, loadDelegateConfig, resolveEffort } from './config';
import { buildParentHandoff } from './output';
import { renderDelegateCall, renderDelegateResult } from './render';
import { mapWithConcurrency, runDelegate } from './runner';
import {
  buildSessionSnapshotJsonl,
  createDelegateSession,
  resolveDelegateSession,
} from './session';
import {
  createRun,
  type DelegateDetails,
  type DelegatedRun,
  type DelegateEffortState,
  isRunError,
} from './types';

const EffortSchema = StringEnum(EFFORT_LEVELS, {
  description:
    'Optional child model profile: economy for cost-efficient routine work, balanced, or deep.',
});
const ContextSchema = StringEnum(['branch', 'fresh'] as const, {
  description:
    'Optional context mode. fresh starts with the task and project instructions; branch also includes parent conversation history.',
});
const ScopeSchema = Type.Array(Type.String({ maxLength: 4096 }), {
  maxItems: 100,
  description:
    'Advisory paths where work is expected. This helps coordinate parallel writes but is not a hard boundary.',
});

const TaskItem = Type.Object({
  task: Type.String({
    minLength: 1,
    maxLength: 32 * 1024,
    description: 'Focused task or continuation feedback',
  }),
  cwd: Type.Optional(Type.String({ maxLength: 4096 })),
  effort: Type.Optional(EffortSchema),
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
  allowWrites: Type.Optional(Type.Boolean()),
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
  effort: Type.Optional(EffortSchema),
  context: Type.Optional(ContextSchema),
  contextNote: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  scope: Type.Optional(ScopeSchema),
  continuation: Type.Optional(Type.String({ maxLength: 512 })),
  allowWrites: Type.Optional(Type.Boolean()),
});

function makeDetails(
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
): DelegateDetails {
  return { mode, runs };
}

type DelegateParamsInput = Static<typeof DelegateParams>;

function invalidParams(message: string): never {
  throw new Error(message);
}

export function prepareDelegateArguments(args: unknown): DelegateParamsInput {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return args as DelegateParamsInput;
  const input = args as Record<string, unknown>;
  const prepared: Record<string, unknown> = { ...input };
  if (input.effort === 'fast') prepared.effort = 'economy';
  if (Array.isArray(input.tasks))
    prepared.tasks = input.tasks.map((task) => {
      if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
      const item = task as Record<string, unknown>;
      return item.effort === 'fast' ? { ...item, effort: 'economy' } : task;
    });
  return prepared as DelegateParamsInput;
}

function effortFor(
  requested: unknown,
  config: ReturnType<typeof loadDelegateConfig>,
): {
  effort?: DelegateEffortState;
  error?: string;
} {
  const resolved = resolveEffort(requested, config);
  return resolved.error ? { error: resolved.error } : { effort: resolved };
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
      'Delegate focused work to child Pi processes with isolated context windows. Effort profiles are economy for cost-efficient routine work, balanced, and deep. Children can be continued using the opaque continuation token returned in run details. contextNote supplies curated prose context. scope is advisory for coordinating parallel writes.',
    promptSnippet:
      'Delegate substantial focused exploration, review, validation, implementation, or independent parallel work when a child process would save context.',
    promptGuidelines: [
      'Prefer direct tools for small work and economy effort for routine, cost-efficient delegation; use balanced or deep only when the task benefits from the additional capability. Do not create research, implementation, test, or review stages unless each adds concrete value.',
      'Use contextNote to give a fresh child only the relevant decisions, constraints, and prior findings; use branch only when exact parent history matters.',
      'Continue a child when it already has useful task context and needs focused correction or extension; start fresh when its approach is unsuitable or an independent view is more valuable.',
      "Parallelize only independent work. When one task depends on another's findings, inspect the first result before starting or continuing the next; for parallel writes, provide advisory scopes where practical and avoid knowingly overlapping mutations.",
      'Treat delegated results as evidence rather than authority: use reported checks and concrete evidence, and verify directly or continue the child when important claims remain unsupported.',
      'Delegate cannot be called by child processes.',
    ],
    parameters: DelegateParams,
    prepareArguments: prepareDelegateArguments,
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
        const effort = effortFor(params.effort, config);
        if (effort.error) return invalidParams(effort.error);
        if (
          params.continuation &&
          (params.cwd !== undefined || params.context !== undefined)
        )
          return invalidParams(
            'A continuation reuses its original cwd and context; do not provide cwd or context.',
          );
        const resumed = params.continuation
          ? resolveDelegateSession(params.continuation)
          : undefined;
        if (params.continuation && !resumed)
          return invalidParams(
            'Unknown or expired delegate continuation token.',
          );
        const cwd = resumed?.cwd ?? params.cwd ?? ctx.cwd;
        const context = resumed ? 'continuation' : (params.context ?? 'fresh');
        const snapshot =
          !resumed && context === 'branch' ? getSnapshot(cwd) : undefined;
        if (!resumed && context === 'branch' && !snapshot)
          return invalidParams(
            'Cannot delegate: failed to snapshot current session branch.',
          );
        const session =
          resumed ??
          createDelegateSession({ cwd, snapshotJsonl: snapshot ?? undefined });
        const run = await runDelegate({
          cwd,
          task: params.task.trim(),
          context,
          sessionPath: session.filePath,
          continuation: session.token,
          resuming: Boolean(resumed),
          contextNote: params.contextNote,
          scope: params.scope,
          effort: effort.effort,
          allowWrites: params.allowWrites ?? false,
          timeoutMs: config.timeoutMs,
          maxConcurrency: config.maxConcurrency,
          signal,
          onUpdate,
          makeDetails: (runs) => makeDetails('single', runs),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: buildParentHandoff([run]),
            },
          ],
          details: makeDetails('single', [run]),
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
      const efforts = tasks.map((item) =>
        effortFor(item.effort ?? params.effort, config),
      );
      const effortError = efforts.find((item) => item.error)?.error;
      if (effortError) return invalidParams(effortError);
      if (params.continuation)
        return invalidParams(
          'For parallel delegation, set continuation on each task rather than as a shared default.',
        );
      const resumed = tasks.map((item) => {
        if (
          item.continuation &&
          (item.cwd !== undefined || item.context !== undefined)
        )
          return invalidParams(
            'A continuation task cannot provide cwd or context.',
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
        (params.cwd !== undefined || params.context !== undefined)
      )
        return invalidParams(
          'Parallel continuations reuse their original cwd and history; do not provide top-level cwd or context.',
        );
      const contexts = tasks.map((item, index) =>
        resumed[index]
          ? ('continuation' as const)
          : (item.context ?? params.context ?? 'fresh'),
      );
      const cwds = tasks.map(
        (item, index) =>
          resumed[index]?.cwd ?? item.cwd ?? params.cwd ?? ctx.cwd,
      );
      const notes = tasks.map((item) => item.contextNote ?? params.contextNote);
      const scopes = tasks.map((item) => item.scope ?? params.scope);
      const writes = tasks.map(
        (item) => item.allowWrites ?? params.allowWrites ?? false,
      );
      const warnings = writeWarnings(cwds, writes, scopes);
      for (let i = 0; i < tasks.length; i++) {
        if (!resumed[i] && contexts[i] === 'branch' && !getSnapshot(cwds[i]))
          return invalidParams(
            'Cannot delegate: failed to snapshot current session branch.',
          );
      }
      const sessions = tasks.map(
        (_, index) =>
          resumed[index] ??
          createDelegateSession({
            cwd: cwds[index],
            snapshotJsonl:
              contexts[index] === 'branch'
                ? (getSnapshot(cwds[index]) ?? undefined)
                : undefined,
          }),
      );
      const liveRuns = tasks.map((item, index) =>
        createRun(item.task, efforts[index].effort, {
          cwd: cwds[index],
          context: contexts[index],
          contextNote: notes[index],
          scope: scopes[index],
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
          const run = await runDelegate({
            cwd: cwds[index],
            task: item.task,
            context: contexts[index],
            sessionPath: sessions[index].filePath,
            continuation: sessions[index].token,
            resuming: Boolean(resumed[index]),
            contextNote: notes[index],
            scope: scopes[index],
            effort: efforts[index].effort,
            allowWrites: writes[index],
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
          run.warnings = warnings[index];
          liveRuns[index] = run;
          emit();
          return run;
        },
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: buildParentHandoff(runs),
          },
        ],
        details: makeDetails('parallel', runs),
      };
    },
  });
}
