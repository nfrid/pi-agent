import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { DelegateConfig } from './config';
import { loadIsolation, type PreparedIsolation } from './isolation';
import {
  failedLifecycleRun,
  finalizeIsolatedRun,
  isolationDetails,
  markLifecycleFailure,
} from './isolation-lifecycle';
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

type SnapshotLookup = (cwd: string) => string | null;

type RunContext = {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: DelegateConfig;
  signal?: AbortSignal;
  getSnapshot: SnapshotLookup;
};

type RunHooks = {
  onUpdate?: (partial: import('./types').DelegateProgressUpdate) => void;
  onIsolationRunning?: (isolation: PreparedIsolation) => void;
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
    if (!prepared.isolation || prepared.plan.resumed || markedRunning)
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
  isolation?: ReturnType<typeof isolationDetails>;
}> {
  if (!prepared.isolation || markedRunning) return { warnings: [] };
  if (!prepared.plan.resumed) return cleanupFreshPreparedTask(prepared);
  return {
    warnings: [],
    isolation: isolationDetails(
      loadIsolation(prepared.isolation.record.id) ?? prepared.isolation.record,
    ),
  };
}

async function runPreparedWithLifecycle(
  runCtx: RunContext,
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
      onIsolationRunning: (isolation) => {
        markedRunning = true;
        hooks.onIsolationRunning?.(isolation);
      },
    });
  } catch (error) {
    if (!parallel && (!prepared.isolation || markedRunning)) throw error;
    const cleanup = await cleanupFailedLaunch(prepared, markedRunning);
    const failed = failedLifecycleRun(
      prepared.plan.task,
      prepared.plan.routing,
      {
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
    if (prepared.isolation && markedRunning)
      await markLifecycleFailure(failed, prepared.isolation, error);
    else failed.isolation = cleanup.isolation;
    return failed;
  }

  try {
    await finalizeIsolatedRun(pi, ctx, run, prepared.isolation);
  } catch (error) {
    if (prepared.isolation)
      await markLifecycleFailure(run, prepared.isolation, error);
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

async function executeDelegate(
  runCtx: RunContext,
  params: DelegateParams,
  hooks: RunHooks,
) {
  const built = buildDelegatePlans(
    params,
    runCtx.ctx,
    runCtx.config,
    runCtx.getSnapshot,
  );
  const prepared = await preparePlans(built);

  if (!built.parallel) {
    const run = await runPreparedWithLifecycle(
      runCtx,
      prepared[0],
      'single',
      hooks,
    );
    return delegateToolResult(runCtx.pi, runCtx.ctx, 'single', [run]);
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

  const launchedFreshIsolationIds = new Set<string>();
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
          onIsolationRunning: (isolation) => {
            if (!item.plan.resumed)
              launchedFreshIsolationIds.add(isolation.record.id);
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
  return delegateToolResult(runCtx.pi, runCtx.ctx, 'parallel', runs);
}

export const executeSingleDelegate = executeDelegate;
export const executeParallelDelegate = executeDelegate;
