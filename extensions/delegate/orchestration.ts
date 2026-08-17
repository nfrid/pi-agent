import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { DelegateConfig } from './config';
import { createDelegateControlChannel } from './control';
import { createOpaqueId } from './identity';
import { ensureDelegateLifecycle } from './lifecycle';
import {
  type BuiltDelegateTask,
  buildDelegatePlans,
  resolveDelegateHandoffs,
} from './plans';
import { mapWithConcurrency } from './runner';

import {
  cleanupFreshPreparedTask,
  type PreparedDelegateTask,
  preflightDelegateContinuation,
  prepareDelegateTask,
  rollbackPreparedDelegateTasks,
  runPreparedDelegateTask,
} from './task-lifecycle';
import type { DelegateParams } from './tool';
import {
  buildSessionBoundArtifactBackedHandoff,
  delegateToolResult,
  makeDetails,
} from './tool-result';
import { createRun, type DelegatedRun } from './types';
import {
  WORKFLOW_INPUT_CAPS,
  workflowEvidencePromptBytes,
} from './workflow-inputs';
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
  /** Branch owning exact metadata/artifact writes, captured before awaits. */
  launchBranchId?: string;
  isLaunchBranchActive?: () => boolean;
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
      runId: item.runId,
      sessionId: item.session.sessionId || item.plan.resumed?.sessionId,
      lineageId: item.session.lineageId || item.plan.resumed?.lineageId,
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
    return run;
  });
}

type RunHooks = {
  onUpdate?: (partial: import('./types').DelegateProgressUpdate) => void;
  onRunUpdate?: (run: DelegatedRun, index?: number) => void;
  control?: import('./runner').RunDelegateOptions['control'];
  controls?: readonly NonNullable<
    import('./runner').RunDelegateOptions['control']
  >[];
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
  const launchSessionId =
    runCtx.launchSessionId ?? runCtx.ctx.sessionManager.getSessionId();
  const parallel = mode === 'parallel';
  // Setup failures still represent one stable invocation in public details.
  const runId = prepared.runId;
  const sessionId =
    prepared.session.sessionId || prepared.plan.resumed?.sessionId;
  const lineageId =
    prepared.session.lineageId || prepared.plan.resumed?.lineageId;
  if (prepared.setupFailure) {
    return failedLifecycleRun(
      prepared.plan.task,
      prepared.plan.routing,
      {
        runId,
        sessionId,
        lineageId,
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
      ownerSessionId: launchSessionId,
      control: hooks.control,
      onUpdate: hooks.onUpdate,
      onRunUpdate: hooks.onRunUpdate,
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
        runId,
        sessionId,
        lineageId,
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
    runId: createOpaqueId(),
    session: {
      token: task.plan.resumed?.token ?? '',
      sessionId: task.plan.resumed?.sessionId ?? '',
      lineageId: task.plan.resumed?.lineageId ?? '',
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
  const launchSessionId =
    runCtx.launchSessionId ?? runCtx.ctx.sessionManager.getSessionId();
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
    tasks: await preparePlans(tasks, built.parallel, launchSessionId),
  };
}

export async function runPreparedDelegateExecution(
  runCtx: DelegateRunContext,
  execution: PreparedDelegateExecution,
  hooks: RunHooks = {},
): Promise<DelegatedRun[]> {
  const prepared = execution.tasks;
  if (execution.mode === 'single') {
    const run = await runPreparedWithLifecycle(runCtx, prepared[0], 'single', {
      ...hooks,
      control: hooks.controls?.[0] ?? hooks.control,
    });
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
          control: hooks.controls?.[index],
          onRunUpdate: (current) => {
            liveRuns[index] = current;
            hooks.onRunUpdate?.(current, index);
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
  const launchSessionId =
    runCtx.launchSessionId ?? runCtx.ctx.sessionManager.getSessionId();
  const launchBranchId = runCtx.launchBranchId;
  const execution = await prepareDelegateExecution(runCtx, params);
  const runs = await runPreparedDelegateExecution(runCtx, execution, hooks);
  return delegateToolResult(
    runCtx.pi,
    runCtx.ctx,
    execution.mode,
    runs,
    launchSessionId,
    launchBranchId,
    runCtx.isLaunchBranchActive,
  );
}

export const executeSingleDelegate = executeDelegate;
export const executeParallelDelegate = executeDelegate;

export interface AsyncDelegateLaunchHooks {
  onRunUpdate?: (run: DelegatedRun) => void;
}

/**
 * Prepare exactly one coordinator-owned delegate only after its dependency
 * barrier has opened. The returned discard callback owns every resource made
 * before the adapter receives the launch.
 */
export async function prepareDelegateWorkflowLaunch(
  runCtx: DelegateRunContext,
  plan: import('./task-lifecycle').DelegateTaskPlan,
  workflow: import('./workflow-coordinator').DelegateWorkflowLaunchContext,
  hooks: AsyncDelegateLaunchHooks = {},
): Promise<import('./workflow-coordinator').DelegateWorkflowPreparedLaunch> {
  const launchSessionId =
    runCtx.launchSessionId ?? runCtx.ctx.sessionManager.getSessionId();
  const launchBranchId = runCtx.launchBranchId;
  let launchPlan = plan;
  const branch = workflow.inputs.find(
    (input) => input.kind === 'branch',
  )?.branch;
  if (branch) {
    if (
      plan.resumed ||
      plan.cwdExplicit ||
      (plan.isolationExplicit && plan.isolation !== 'worktree') ||
      plan.base !== undefined ||
      plan.worktreePath !== undefined ||
      plan.baseRef !== undefined
    )
      throw new Error(
        'A symbolic branch input requires a fresh worktree delegate without from or worktreePath.',
      );
    launchPlan = {
      ...plan,
      requestedCwd: branch.repositoryRoot,
      isolation: 'worktree',
      base: undefined,
      baseRef: branch.headCommit,
      workingDirectory: branch.workingDirectory,
    };
  }

  const built: BuiltDelegateTask = {
    plan: launchPlan,
    preflight: preflightDelegateContinuation(launchPlan),
  };
  const resolved = await resolveDelegateHandoffs(runCtx.ctx, [built]);
  const resolvedTask = resolved[0];
  if (!resolvedTask) throw new Error('Delegate setup produced no task.');
  const handoffParts = [
    resolvedTask.plan.handoffText,
    workflow.handoffText,
  ].filter((text): text is string => Boolean(text?.trim()));
  if (
    handoffParts.length > 1 &&
    workflowEvidencePromptBytes(handoffParts) >
      WORKFLOW_INPUT_CAPS.aggregateMaxBytes
  )
    throw new Error(
      'Combined delegate handoff evidence exceeds the workflow input limit.',
    );
  const finalPlan = {
    ...resolvedTask.plan,
    ...(handoffParts.length ? { handoffText: handoffParts.join('\n\n') } : {}),
  };
  const prepared = await prepareDelegateTask(
    finalPlan,
    preflightDelegateContinuation(finalPlan),
    launchSessionId,
    workflow.signal,
  );
  const pending = pendingRuns({ mode: 'single', tasks: [prepared] })[0];
  if (pending) hooks.onRunUpdate?.(pending);
  const ownerSessionId = launchSessionId;
  let control: ReturnType<typeof createDelegateControlChannel>;
  try {
    control = createDelegateControlChannel(
      prepared.session.filePath,
      ownerSessionId,
      'background',
    );
  } catch (error) {
    await rollbackPreparedDelegateTasks([prepared]);
    throw error;
  }
  let discarded = false;
  const discard = async () => {
    if (discarded) return;
    discarded = true;
    control.close();
    await rollbackPreparedDelegateTasks([prepared]);
  };
  const materialize = async (ctx: ExtensionContext, runs: DelegatedRun[]) => {
    const handoff = await buildSessionBoundArtifactBackedHandoff(
      runCtx.pi,
      ctx,
      ownerSessionId,
      runs,
      launchBranchId,
      runCtx.isLaunchBranchActive,
    );
    return { runs, retainedRuns: runs, handoff };
  };
  return {
    discard,
    launch: {
      name: finalPlan.name,
      ownerSessionId,
      ownerBranchId: launchBranchId,
      mode: 'single',
      tasks: [finalPlan.task],
      route: finalPlan.routing?.route,
      allowWrites: prepared.allowWrites,
      feedback: (message) => control.enqueue('feedback', message),
      execute: async (signal) => {
        try {
          const runs = await runPreparedDelegateExecution(
            { ...runCtx, signal },
            { mode: 'single', tasks: [prepared] },
            {
              control,
              onRunUpdate: (run) => hooks.onRunUpdate?.(run),
            },
          );
          const finalRun = runs[0];
          if (finalRun) hooks.onRunUpdate?.(finalRun);
          control.close();
          return await materialize(runCtx.ctx, runs);
        } finally {
          control.close();
        }
      },
      materialize,
    },
  };
}
