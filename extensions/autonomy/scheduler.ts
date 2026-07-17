import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { buildArtifactBackedHandoff } from '../delegate';
import { loadDelegateConfig, resolveDelegateRoute } from '../delegate/config';
import { runDelegate } from '../delegate/runner';
import { createDelegateSession } from '../delegate/session';
import {
  type DelegateDetails,
  type DelegatedRun,
  isRunError,
} from '../delegate/types';
import { mutate } from '../tasks/core';
import { readyTasks } from '../tasks/queries';
import { getState, persist } from '../tasks/state';
import type { Task } from '../tasks/types';
import type { AutonomyProfile } from './types';

const PRIORITY = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

export interface SchedulerBudget {
  maxChildren: number;
  maxConcurrency: number;
  maxDurationMs: number;
  maxTurns: number;
  maxComputeUnits: number;
  targetOutputTokens: number;
  targetCostUsd: number;
}

export interface SchedulerResult {
  handoff: string;
  details: DelegateDetails & {
    selectedTaskIds: string[];
    skippedTaskIds: string[];
    budget: SchedulerBudget;
    stoppedReason?: string;
    targetOvershoot?: {
      outputTokens: number;
      costUsd: number;
    };
  };
}

function taskOrder(left: Task, right: Task): number {
  const priority =
    PRIORITY[left.priority ?? 'normal'] - PRIORITY[right.priority ?? 'normal'];
  return (
    priority ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  );
}

export function findDependencyCycles(tasks = getState().tasks): string[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const walk = (id: string) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) walk(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) walk(task.id);
  return cycles;
}

export function boundedBudget(
  profile: AutonomyProfile,
  requested: Partial<SchedulerBudget>,
): SchedulerBudget {
  const defaults = profile.scheduler;
  const positive = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  const integer = (key: keyof SchedulerBudget) =>
    Math.min(
      defaults[key],
      Math.floor(positive(requested[key], defaults[key])),
    );
  return {
    maxChildren: integer('maxChildren'),
    maxConcurrency: integer('maxConcurrency'),
    maxDurationMs: integer('maxDurationMs'),
    maxTurns: integer('maxTurns'),
    maxComputeUnits: integer('maxComputeUnits'),
    targetOutputTokens: integer('targetOutputTokens'),
    targetCostUsd: Math.min(
      defaults.targetCostUsd,
      positive(requested.targetCostUsd, defaults.targetCostUsd),
    ),
  };
}

export async function runSequentialTaskControl(options: {
  tasks: Task[];
  maxChildren: number;
  execute: (task: Task) => Promise<DelegatedRun>;
}): Promise<{ selectedTaskIds: string[]; runs: DelegatedRun[] }> {
  const byId = new Map(options.tasks.map((task) => [task.id, task]));
  const selected = options.tasks
    .filter(
      (task) =>
        task.status === 'todo' &&
        task.dependsOn.every((id) => byId.get(id)?.status === 'done'),
    )
    .sort(taskOrder)
    .slice(0, options.maxChildren);
  const runs: DelegatedRun[] = [];
  for (const task of selected) runs.push(await options.execute(task));
  return {
    selectedTaskIds: selected.map((task) => task.id),
    runs,
  };
}

function usage(runs: DelegatedRun[]): {
  output: number;
  cost: number;
  turns: number;
  computeUnits: number;
} {
  return runs.reduce(
    (total, run) => ({
      output: total.output + run.usage.output,
      cost: total.cost + run.usage.cost,
      turns: total.turns + run.usage.turns,
      computeUnits: total.computeUnits + run.usage.computeUnits,
    }),
    { output: 0, cost: 0, turns: 0, computeUnits: 0 },
  );
}

export async function runReadyTaskScheduler(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  profile: AutonomyProfile;
  requestedBudget?: Partial<SchedulerBudget>;
  route?: unknown;
  signal?: AbortSignal;
  onUpdate?: (text: string, details: DelegateDetails) => void;
  runDelegateFn?: typeof runDelegate;
  createSessionFn?: typeof createDelegateSession;
}): Promise<SchedulerResult> {
  const cycles = findDependencyCycles();
  if (cycles.length > 0)
    throw new Error(
      `Todo dependency cycle detected: ${cycles.map((cycle) => cycle.join(' -> ')).join('; ')}`,
    );
  const budget = boundedBudget(options.profile, options.requestedBudget ?? {});
  const ready = readyTasks().sort(taskOrder);
  const selected = ready.slice(0, budget.maxChildren);
  const skipped = ready.slice(selected.length);
  if (selected.length === 0)
    return {
      handoff: 'No ready todo tasks to schedule.',
      details: {
        mode: 'parallel',
        runs: [],
        selectedTaskIds: [],
        skippedTaskIds: [],
        budget,
      },
    };

  const config = loadDelegateConfig(options.ctx.cwd);
  const selection = resolveDelegateRoute(options.route, config);
  if (selection.error) throw new Error(selection.error);
  const computeUnitsPerTurn = selection.routing?.computeUnitsPerTurn ?? 1;
  const runs: DelegatedRun[] = [];
  const startedAt = Date.now();
  const deadline = startedAt + budget.maxDurationMs;
  const killGraceMs = Math.min(1000, Math.floor(budget.maxDurationMs / 2));
  const deadlineController = new AbortController();
  const onExternalAbort = () => deadlineController.abort();
  if (options.signal?.aborted) deadlineController.abort();
  else
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    Math.max(0, budget.maxDurationMs - killGraceMs),
  );
  deadlineTimer.unref();
  let stoppedReason: string | undefined;
  let reservedTurns = 0;
  let reservedComputeUnits = 0;

  try {
    for (let offset = 0; offset < selected.length; ) {
      const elapsed = Date.now() - startedAt;
      const totals = usage(runs);
      if (elapsed >= budget.maxDurationMs) {
        stoppedReason = 'duration budget reached';
        break;
      }
      if (reservedTurns >= budget.maxTurns) {
        stoppedReason = 'turn budget reached';
        break;
      }
      if (reservedComputeUnits >= budget.maxComputeUnits) {
        stoppedReason = 'compute-unit budget reached';
        break;
      }
      if (totals.output >= budget.targetOutputTokens) {
        stoppedReason = 'advisory output-token target reached';
        break;
      }
      if (totals.cost >= budget.targetCostUsd) {
        stoppedReason = 'advisory cost target reached';
        break;
      }
      const remainingDuration = budget.maxDurationMs - elapsed;
      if (remainingDuration <= killGraceMs) {
        stoppedReason = 'insufficient duration budget for safe termination';
        break;
      }
      const remainingTurns = budget.maxTurns - reservedTurns;
      const remainingComputeUnits =
        budget.maxComputeUnits - reservedComputeUnits;
      const affordableChildren = Math.min(
        remainingTurns,
        Math.floor(remainingComputeUnits / computeUnitsPerTurn),
      );
      const batchSize = Math.min(
        budget.maxConcurrency,
        selected.length - offset,
        affordableChildren,
      );
      if (batchSize < 1) {
        stoppedReason = 'insufficient local turn/compute budget';
        break;
      }
      const remainingTasks = selected.length - offset;
      const turnsPerChild = Math.max(
        1,
        Math.min(
          Math.floor(remainingTurns / remainingTasks),
          Math.floor(
            remainingComputeUnits / (remainingTasks * computeUnitsPerTurn),
          ) || 1,
        ),
      );
      const computeUnitsPerChild = turnsPerChild * computeUnitsPerTurn;
      const runTimeoutMs = Math.max(1, remainingDuration - killGraceMs);
      const batch = selected.slice(offset, offset + batchSize);
      const batchRuns = await Promise.all(
        batch.map(async (task) => {
          mutate('start', { action: 'start', id: task.id });
          persist(options.pi);
          const session = (options.createSessionFn ?? createDelegateSession)({
            cwd: options.ctx.cwd,
            routing: selection.routing,
          });
          const run = await (options.runDelegateFn ?? runDelegate)({
            cwd: options.ctx.cwd,
            task: task.text,
            context: 'fresh',
            sessionPath: session.filePath,
            continuation: session.token,
            routing: selection.routing,
            allowWrites: false,
            writeRequested: false,
            timeoutMs: Math.min(config.timeoutMs, runTimeoutMs),
            killGraceMs,
            maxConcurrency: budget.maxConcurrency,
            maxTurns: turnsPerChild,
            maxComputeUnits: computeUnitsPerChild,
            signal: deadlineController.signal,
            makeDetails: (items) => ({ mode: 'parallel', runs: items }),
            onUpdate: (partial) =>
              options.onUpdate?.(`Scheduled todo ${task.id}`, partial.details),
          });
          if (isRunError(run)) {
            mutate('block', {
              action: 'block',
              id: task.id,
              notes: `Scheduled delegate failed; continuation ${session.token}`,
            });
          } else {
            mutate('update', {
              action: 'update',
              id: task.id,
              status: 'doing',
              notes: `Scheduled delegate completed; parent evidence review required before done. Continuation ${session.token}`,
            });
          }
          persist(options.pi);
          return run;
        }),
      );
      runs.push(...batchRuns);
      // Reservations, rather than fallible event accounting, own aggregate
      // admission. Unused child allowance is deliberately not recycled.
      reservedTurns += turnsPerChild * batch.length;
      reservedComputeUnits += computeUnitsPerChild * batch.length;
      offset += batch.length;
      if (batchRuns.some(isRunError)) {
        stoppedReason =
          Date.now() >= deadline - killGraceMs
            ? 'duration budget reached'
            : 'delegate failure stopped further fan-out';
        break;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  const unlaunched = selected.slice(runs.length);
  const totals = usage(runs);
  const targetOvershoot = {
    outputTokens: Math.max(0, totals.output - budget.targetOutputTokens),
    costUsd: Math.max(0, totals.cost - budget.targetCostUsd),
  };
  const handoff = await buildArtifactBackedHandoff(
    options.pi,
    options.ctx,
    runs,
  );
  return {
    handoff: `${handoff}${stoppedReason ? `\n\nScheduler stopped: ${stoppedReason}.` : ''}`,
    details: {
      mode: 'parallel',
      runs,
      selectedTaskIds: selected.slice(0, runs.length).map((task) => task.id),
      skippedTaskIds: [...unlaunched, ...skipped].map((task) => task.id),
      budget,
      ...(stoppedReason ? { stoppedReason } : {}),
      ...(targetOvershoot.outputTokens > 0 || targetOvershoot.costUsd > 0
        ? { targetOvershoot }
        : {}),
    },
  };
}
