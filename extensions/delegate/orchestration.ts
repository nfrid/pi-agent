import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { DelegateConfig } from './config';
import { ensureDelegateLifecycle, setDelegateLifecycle } from './lifecycle';
import {
  type BuiltDelegateTask,
  buildDelegatePlans,
  resolveDelegateHandoffs,
} from './plans';
import { mapWithConcurrency } from './runner';
import {
  setDelegateResultSpec,
  settleDelegateResult,
} from './structured-result';
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
import {
  loadWorktree,
  type PreparedWorktree,
  worktreeSummary,
} from './worktree';
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
  /** Session owning the invocation, captured before preparation can await. */
  launchSessionId?: string;
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
  return execution.tasks.map((item) => {
    const run = createRun(item.plan.task, item.plan.routing, {
      name: item.plan.name,
      cwd: item.cwd,
      context: item.plan.context,
      contextNote: item.plan.contextNote,
      scope: item.scope,
      writeRequested: item.plan.writeRequested,
      allowWrites: item.allowWrites,
      isolation: item.isolation,
      worktree: item.worktree
        ? worktreeSummary(item.worktree.record)
        : undefined,
      continuation: item.setupFailure
        ? item.plan.resumed?.token
        : item.session.token,
      warnings: item.warnings,
    });
    setDelegateResultSpec(run, item.plan.resultSpec);
    return run;
  });
}

type RunHooks = {
  onUpdate?: (partial: import('./types').DelegateProgressUpdate) => void;
  control?: import('./runner').RunDelegateOptions['control'];
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
  if (!prepared.worktree || prepared.plan.resumed || markedRunning)
    return { continuation: prepared.session.token };
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
  const { config, signal } = runCtx;
  const parallel = mode === 'parallel';
  if (prepared.setupFailure) {
    return failedLifecycleRun(
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
        isolation: prepared.isolation,
        continuation: prepared.plan.resumed?.token,
        warnings: prepared.warnings,
      },
      prepared.setupFailure,
      'setup-failure',
    );
  }
  let markedRunning = false;
  let run: DelegatedRun;
  try {
    run = await runPreparedDelegateTask(prepared, {
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.maxConcurrency,
      signal,
      control: hooks.control,
      onUpdate: hooks.onUpdate,
      mode,
      onWorktreeRunning: (worktree) => {
        markedRunning = true;
        hooks.onWorktreeRunning?.(worktree);
      },
    });
  } catch (error) {
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
        isolation: prepared.isolation,
        ...continuationOnFailure(prepared, markedRunning, parallel),
        warnings: [...prepared.warnings, ...cleanup.warnings],
      },
      error,
    );
    if (prepared.worktree && markedRunning)
      markLifecycleFailure(
        failed,
        prepared.worktree,
        error,
        'provider-runner-error',
      );
    else failed.worktree = cleanup.worktree;
    return failed;
  }

  try {
    await finalizeWorktreeRun(run, prepared.worktree, prepared.plan.name);
  } catch (error) {
    if (prepared.worktree) markLifecycleFailure(run, prepared.worktree, error);
    else throw error;
  }
  // Settlement validation happens after the child and worktree lifecycle have
  // both settled, and is idempotent for artifact materialization.
  const lifecycleBeforeSettlement = ensureDelegateLifecycle(run);
  const settlement = settleDelegateResult(run, prepared.plan.resultSpec);
  if (
    settlement &&
    !settlement.valid &&
    (!lifecycleBeforeSettlement ||
      lifecycleBeforeSettlement.reason === 'unknown')
  )
    setDelegateLifecycle(
      run,
      'child-result-invalid',
      settlement.errors.join('; '),
    );
  ensureDelegateLifecycle(run);
  return run;
}

function setupFailurePlans(
  built: BuiltDelegateTask[],
  diagnostic: string,
  extraWarnings: string[] = [],
): PreparedDelegateTask[] {
  return built.map((task) => ({
    ...task.preflight,
    plan: task.plan,
    worktree: undefined,
    session: {
      token: task.plan.resumed?.token ?? '',
      filePath: '',
      cwd: task.preflight.cwd,
      isolation: task.preflight.isolation,
    },
    setupFailure: diagnostic,
    warnings: [...task.plan.warnings, ...extraWarnings],
  }));
}

async function preparePlans(
  built: BuiltDelegateTask[],
  parallel: boolean,
  parentSessionId?: string,
): Promise<PreparedDelegateTask[]> {
  const prepared: PreparedDelegateTask[] = [];
  try {
    for (const task of built)
      prepared.push(
        await prepareDelegateTask(task.plan, task.preflight, parentSessionId),
      );
    return prepared;
  } catch (error) {
    const cleanupWarnings = await rollbackPreparedDelegateTasks(prepared);
    const prefix = parallel
      ? 'Parallel delegate setup failed before launch'
      : 'Delegate setup failed before launch';
    const diagnostic = `${prefix}: ${errorText(error)}${cleanupWarnings.length ? ` Cleanup warnings: ${cleanupWarnings.join(' ')}` : ''}`;
    // Preparation is atomic, but a setup failure is still a delegate
    // settlement. Keep one harness-created run per requested task so single,
    // parallel, foreground, and background surfaces expose the same contract.
    return setupFailurePlans(built, diagnostic, cleanupWarnings);
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
  let tasks: BuiltDelegateTask[];
  try {
    tasks = await resolveDelegateHandoffs(runCtx.ctx, built.tasks);
  } catch (error) {
    return {
      mode: built.parallel ? 'parallel' : 'single',
      tasks: setupFailurePlans(
        built.tasks,
        `Delegate setup failed before launch: ${errorText(error)}`,
      ),
    };
  }
  return {
    mode: built.parallel ? 'parallel' : 'single',
    tasks: await preparePlans(
      tasks,
      built.parallel,
      runCtx.launchSessionId ?? runCtx.ctx.sessionManager.getSessionId(),
    ),
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
  const launchSessionId =
    runCtx.launchSessionId ?? runCtx.ctx.sessionManager.getSessionId();
  return delegateToolResult(
    runCtx.pi,
    runCtx.ctx,
    execution.mode,
    runs,
    launchSessionId,
  );
}

export const executeSingleDelegate = executeDelegate;
export const executeParallelDelegate = executeDelegate;
