import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { DelegateConfig } from './config';
import { invalidParams } from './param-errors';
import { buildDelegatePlans } from './plans';
import { mapWithConcurrency } from './runner';
import {
  cleanupFreshPreparedTask,
  type PreparedDelegateTask,
  prepareDelegateTask,
  rollbackPreparedDelegateTasks,
  runPreparedDelegateTask,
} from './task-lifecycle';
import type { DelegateParams } from './tool';
import { delegateToolResult, makeDetails } from './tool-result';
import { createRun, type DelegatedRun } from './types';
import { loadWorktree, type PreparedWorktree } from './worktree';
import {
  failedLifecycleRun,
  finalizeWorktreeRun,
  markLifecycleFailure,
  worktreeDetails,
} from './worktree-lifecycle';

type SnapshotLookup = (cwd: string) => string | null;

export type DelegateRunContext = {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: DelegateConfig;
  signal?: AbortSignal;
  getSnapshot: SnapshotLookup;
};

export interface PreparedDelegateExecution {
  mode: 'single' | 'parallel';
  tasks: PreparedDelegateTask[];
}

export function pendingRuns(
  execution: PreparedDelegateExecution,
): DelegatedRun[] {
  return execution.tasks.map((item) =>
    createRun(item.plan.task, item.plan.routing, {
      name: item.plan.name,
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
}

type RunHooks = {
  onUpdate?: (partial: import('./types').DelegateProgressUpdate) => void;
  onWorktreeRunning?: (worktree: PreparedWorktree) => void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function continuationOnFailure(
  prepared: PreparedDelegateTask,
  markedRunning: boolean,
  parallel: boolean,
): { continuation?: string } {
  if (parallel) {
    if (!prepared.worktree || prepared.plan.resumed || markedRunning)
      return { continuation: prepared.session.token };
    return {};
  }
  if (prepared.plan.resumed) return { continuation: prepared.session.token };
  return {};
}

async function cleanupFailedLaunch(
  prepared: PreparedDelegateTask,
  markedRunning: boolean,
): Promise<{
  warnings: string[];
  worktree?: ReturnType<typeof worktreeDetails>;
}> {
  if (!prepared.worktree || markedRunning) return { warnings: [] };
  if (!prepared.plan.resumed) return cleanupFreshPreparedTask(prepared);
  return {
    warnings: [],
    worktree: worktreeDetails(
      loadWorktree(prepared.worktree.record.id) ?? prepared.worktree.record,
    ),
  };
}

async function runPreparedWithLifecycle(
  runCtx: DelegateRunContext,
  prepared: PreparedDelegateTask,
  mode: 'single' | 'parallel',
  hooks: RunHooks = {},
): Promise<DelegatedRun> {
  const { pi, ctx, config, signal } = runCtx;
  const parallel = mode === 'parallel';
  let markedRunning = false;
  let run: DelegatedRun;
  try {
    run = await runPreparedDelegateTask(prepared, {
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.maxConcurrency,
      signal,
      onUpdate: hooks.onUpdate,
      mode,
      onWorktreeRunning: (worktree) => {
        markedRunning = true;
        hooks.onWorktreeRunning?.(worktree);
      },
    });
  } catch (error) {
    if (!parallel && (!prepared.worktree || markedRunning)) throw error;
    const cleanup = await cleanupFailedLaunch(prepared, markedRunning);
    const failed = failedLifecycleRun(
      prepared.plan.task,
      prepared.plan.routing,
      {
        name: prepared.plan.name,
        cwd: prepared.cwd,
        context: prepared.plan.context,
        contextNote: prepared.plan.contextNote,
        scope: prepared.scope,
        writeRequested: prepared.plan.writeRequested,
        allowWrites: prepared.allowWrites,
        ...continuationOnFailure(prepared, markedRunning, parallel),
        warnings: [...prepared.warnings, ...cleanup.warnings],
      },
      error,
    );
    if (prepared.worktree && markedRunning)
      markLifecycleFailure(failed, prepared.worktree, error);
    else failed.worktree = cleanup.worktree;
    return failed;
  }

  try {
    await finalizeWorktreeRun(run, prepared.worktree, prepared.plan.name);
  } catch (error) {
    if (prepared.worktree) markLifecycleFailure(run, prepared.worktree, error);
    else throw error;
  }
  return run;
}

async function preparePlans(
  built: ReturnType<typeof buildDelegatePlans>,
): Promise<PreparedDelegateTask[]> {
  const prepared: PreparedDelegateTask[] = [];
  try {
    for (let index = 0; index < built.plans.length; index++)
      prepared.push(
        await prepareDelegateTask(built.plans[index], built.preflights[index]),
      );
    return prepared;
  } catch (error) {
    const cleanupWarnings = await rollbackPreparedDelegateTasks(prepared);
    const prefix = built.parallel
      ? 'Parallel delegate setup failed before launch'
      : 'Delegate setup failed before launch';
    return invalidParams(
      `${prefix}: ${errorText(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
    );
  }
}

export async function prepareDelegateExecution(
  runCtx: DelegateRunContext,
  params: DelegateParams,
): Promise<PreparedDelegateExecution> {
  const built = buildDelegatePlans(
    params,
    runCtx.ctx,
    runCtx.config,
    runCtx.getSnapshot,
  );
  return {
    mode: built.parallel ? 'parallel' : 'single',
    tasks: await preparePlans(built),
  };
}

export async function runPreparedDelegateExecution(
  runCtx: DelegateRunContext,
  execution: PreparedDelegateExecution,
  hooks: RunHooks = {},
): Promise<DelegatedRun[]> {
  const prepared = execution.tasks;
  if (execution.mode === 'single') {
    const run = await runPreparedWithLifecycle(
      runCtx,
      prepared[0],
      'single',
      hooks,
    );
    return [run];
  }

  const liveRuns = pendingRuns(execution);
  const warningText = [...new Set(prepared.flatMap((item) => item.warnings))];
  const emit = () => {
    const done = liveRuns.filter((run) => run.exitCode !== -1).length;
    hooks.onUpdate?.({
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

  const launchedFreshWorktreeIds = new Set<string>();
  let runs: DelegatedRun[];
  try {
    runs = await mapWithConcurrency(
      prepared,
      runCtx.config.maxConcurrency,
      async (item, index) => {
        const run = await runPreparedWithLifecycle(runCtx, item, 'parallel', {
          onUpdate: (partial) => {
            const current = partial.details?.runs?.[0];
            if (current)
              liveRuns[index] = { ...current, warnings: item.warnings };
            emit();
          },
          onWorktreeRunning: (worktree) => {
            if (!item.plan.resumed)
              launchedFreshWorktreeIds.add(worktree.record.id);
          },
        });
        liveRuns[index] = run;
        emit();
        return run;
      },
    );
  } catch (error) {
    const cleanupWarnings: string[] = [];
    for (const item of prepared) {
      if (
        !item.worktree ||
        item.plan.resumed ||
        launchedFreshWorktreeIds.has(item.worktree.record.id)
      )
        continue;
      const cleanup = await cleanupFreshPreparedTask(item);
      cleanupWarnings.push(...cleanup.warnings);
    }
    throw new Error(
      `${errorText(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`,
    );
  }
  return runs;
}

async function executeDelegate(
  runCtx: DelegateRunContext,
  params: DelegateParams,
  hooks: RunHooks,
) {
  const execution = await prepareDelegateExecution(runCtx, params);
  const runs = await runPreparedDelegateExecution(runCtx, execution, hooks);
  return delegateToolResult(runCtx.pi, runCtx.ctx, execution.mode, runs);
}

export const executeSingleDelegate = executeDelegate;
export const executeParallelDelegate = executeDelegate;
