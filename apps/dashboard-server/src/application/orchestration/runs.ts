import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { TERMINAL_RUN_STATUSES } from '@pi-dashboard/domain';
import type { Run } from '@pi-dashboard/protocol';
import {
  createWorktreeFinisher,
  type WorktreeRecord,
} from '@pi-dashboard/worktree-manager';
import type { RuntimeManager } from '../../runtime-manager.js';
import {
  boundedErrorText,
  errorText,
  idempotencyConflict,
  type OrchestrationHost,
} from './helpers.js';
import { handleRegistryChange } from './runtime-binding.js';

export async function retryRun(
  host: OrchestrationHost,
  threadId: string,
  command: { commandId: string; prompt?: string; model?: Run['model'] },
): Promise<unknown> {
  host.requireThread(threadId);
  const { receipt: _receipt, ...result } = host.repository.retryRunIdempotent(
    command.commandId,
    {
      threadId,
      initialPrompt: command.prompt ?? host.latestRun(threadId).initialPrompt,
      model: command.model,
    },
  );
  host.changed();
  host.kick();
  return result;
}

export async function cancelRun(
  host: OrchestrationHost,
  runId: string,
  commandId: string,
): Promise<unknown> {
  const prior = host.receipt(commandId, 'run.cancel');
  if (prior) {
    const result = prior.result as Run;
    if (result.id !== runId) throw idempotencyConflict(commandId, 'run.cancel');
    return prior.result;
  }
  const active = host.cancelTasks.get(commandId);
  if (active) {
    if (active.runId !== runId)
      throw idempotencyConflict(commandId, 'run.cancel');
    return active.task;
  }
  const task = performCancel(host, runId, commandId);
  host.cancelTasks.set(commandId, { runId, task });
  void task.then(
    () => {
      if (host.cancelTasks.get(commandId)?.task === task)
        host.cancelTasks.delete(commandId);
    },
    () => {
      if (host.cancelTasks.get(commandId)?.task === task)
        host.cancelTasks.delete(commandId);
    },
  );
  return task;
}

export async function performCancel(
  host: OrchestrationHost,
  runId: string,
  commandId: string,
): Promise<Run> {
  const run = host.requireRun(runId);
  const execution = host.executionTasks.get(runId);
  if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
    // Publish cancellation before waiting. The worker rechecks this durable
    // intent after every side-effect boundary and will stop a launch that
    // was already in flight rather than letting it become orphaned.
    try {
      host.repository.transitionRun(runId, 'cancelled');
    } catch {
      try {
        host.repository.transitionRun(runId, 'interrupted');
      } catch {
        /* another lifecycle transition won */
      }
    }
  }
  if (execution) await execution;
  else if (run.runtimeId) {
    try {
      await host.manager.stop(run.runtimeId, true);
    } catch (error) {
      host.repository.setRunError(runId, boundedErrorText(error));
      host.changed();
      host.kick();
      throw error;
    }
  }

  let result = host.repository.getRun(runId) as Run;
  const checkout = host.repository.getCheckout(result.checkoutId);
  // An execution task owns fresh-worktree cleanup. In particular, do not
  // finish a fresh checkout after its provider stop failed: retaining the
  // record is the retry handle for the leaked placement. A later retry of
  // the same cancellation reaches this branch after stop succeeds.
  if (!execution && checkout?.kind === 'worktree') {
    const record = host.worktreeRecord(checkout);
    if (host.freshWorktreeRuns.has(runId)) {
      if (record) {
        const discarded = await createWorktreeFinisher(
          host.storeFor(checkout),
        ).discardFreshWorktree(record.id);
        if (discarded.warning) throw new Error(discarded.warning);
      }
      host.freshWorktreeRuns.delete(runId);
      try {
        host.repository.transitionCheckout(checkout.id, 'retired');
      } catch {
        /* retain terminal state */
      }
    } else if (record) {
      await createWorktreeFinisher(host.storeFor(checkout)).finishWorktree(
        record.id,
        {
          taskName: host.requireThread(result.threadId).title,
          outcome: 'aborted',
        },
      );
      try {
        host.repository.transitionCheckout(checkout.id, 'dirty');
      } catch {
        /* retain terminal state */
      }
    } else {
      try {
        host.repository.transitionCheckout(checkout.id, 'retired');
      } catch {
        /* retain terminal state */
      }
    }
  }
  host.repository.clearRunError(runId);
  result = host.repository.getRun(runId) as Run;
  host.saveReceipt(commandId, 'run.cancel', result);
  host.changed();
  host.kick();
  return result;
}

export async function reconcile(host: OrchestrationHost): Promise<void> {
  for (const run of host.repository.listRuns()) {
    if (TERMINAL_RUN_STATUSES.includes(run.status)) continue;
    if (run.status === 'preparing') {
      // A durable record is the handoff point: it may describe an earlier
      // attempt whose branch contains useful edits. Keep it and let execute
      // rehydrate the same checkout rather than discarding the branch.
      const checkout = host.repository.getCheckout(run.checkoutId);
      if (checkout?.kind === 'worktree' && checkout.status === 'failed') {
        try {
          host.repository.transitionCheckout(checkout.id, 'preparing');
        } catch {
          /* the next worker will fail closed if state is inconsistent */
        }
      }
      host.transitionIfPossible(run.id, 'queued');
      continue;
    }
    if (run.runtimeId) {
      const live = host.registry.get(run.runtimeId);
      if (live && live.online !== false) {
        await handleRegistryChange(host, {
          kind: 'registered',
          snapshot: live,
        });
        continue;
      }
      if (await host.recoverManagedRuntime(run.runtimeId)) {
        if (await host.waitForRuntimeHello(run.runtimeId)) {
          const restored = host.registry.get(run.runtimeId);
          if (restored && restored.online !== false)
            await handleRegistryChange(host, {
              kind: 'registered',
              snapshot: restored,
            });
        } else {
          try {
            await host.stopRecoveredRuntime(run.runtimeId);
          } catch {
            // Retained manager metadata is the retry handle. Cleanup failure
            // must not prevent the rest of dashboard startup reconciliation.
          }
          host.failRun(
            run.id,
            'interrupted',
            'Restored runtime did not reconnect during startup grace.',
          );
        }
        continue;
      }
      host.failRun(
        run.id,
        'interrupted',
        'No recoverable managed runtime was found during startup reconciliation.',
      );
    } else if (['starting', 'running', 'waiting'].includes(run.status)) {
      host.failRun(
        run.id,
        'interrupted',
        'The run had no durable runtime identity during startup reconciliation.',
      );
    }
  }
  host.changed();
}

export async function drain(host: OrchestrationHost): Promise<void> {
  if (host.draining || !host.started) return;
  host.draining = true;
  try {
    for (const run of host.repository.listRuns()) {
      if (run.status !== 'queued' || host.inFlight.has(run.id)) continue;
      const claimed = host.repository.claimQueuedRun(run.id);
      if (!claimed) continue;
      host.inFlight.add(run.id);
      const task = execute(host, claimed);
      host.executionTasks.set(run.id, task);
      void task.then(
        () => {
          if (host.executionTasks.get(run.id) === task)
            host.executionTasks.delete(run.id);
          host.inFlight.delete(run.id);
          void drain(host);
        },
        () => {
          if (host.executionTasks.get(run.id) === task)
            host.executionTasks.delete(run.id);
          host.inFlight.delete(run.id);
          void drain(host);
        },
      );
    }
  } finally {
    host.draining = false;
  }
}

export async function execute(
  host: OrchestrationHost,
  run: Run,
): Promise<void> {
  const checkout = host.requireCheckout(run.checkoutId);
  if (checkout.status === 'retired') {
    host.failRun(
      run.id,
      'failed',
      'Cannot execute a run on a retired checkout.',
    );
    host.changed();
    return;
  }
  const project = host.requireProject(
    host.requireThread(run.threadId).projectId,
  );
  const existingRecord =
    checkout.kind === 'worktree' ? host.worktreeRecord(checkout) : undefined;
  let freshPrepared = false;
  let runtimeId = run.runtimeId;
  // Once a terminal run has reached this boundary, a failed stop must retain
  // the fresh worktree as evidence rather than allowing the catch path to
  // discard the provider's still-live placement.
  let terminalStopAttempted = false;
  let launchAttempted = false;
  try {
    let cwd = checkout.path;
    if (checkout.kind === 'worktree') {
      const creator = host.creatorFor(checkout);
      const record = existingRecord;
      let prepared: WorktreeRecord;
      if (record) {
        // A retry owns the same durable branch. Rehydrate a removed checkout
        // or use its extant path; never prepare a new WIP branch over it.
        prepared = (
          await host.serializedPreparation(() =>
            creator.rehydrateWorktree(record),
          )
        ).record as WorktreeRecord;
      } else {
        const fresh = await host.serializedPreparation(async () => {
          await host.beforeWorktreePreparation?.();
          return creator.prepareWorktree({
            cwd: project.rootPath,
            name: host.requireThread(run.threadId).title,
            ...(project.defaultBaseBranch
              ? { baseRef: project.defaultBaseBranch }
              : { base: 'wip' as const }),
          });
        });
        if (!fresh.worktree) {
          host.failRun(
            run.id,
            'failed',
            fresh.fallbackReason ?? 'Requested worktree preparation failed.',
          );
          const failedCheckout = host.repository.getCheckout(checkout.id);
          const failedRecord =
            failedCheckout && host.worktreeRecord(failedCheckout);
          if (failedRecord)
            await createWorktreeFinisher(
              host.storeFor(checkout),
            ).discardFreshWorktree(failedRecord.id);
          try {
            host.repository.transitionCheckout(checkout.id, 'failed');
          } catch {
            /* preserve the run failure if another lifecycle update won */
          }
          host.changed();
          return;
        }
        prepared = fresh.worktree.record;
        freshPrepared = true;
        host.freshWorktreeRuns.add(run.id);
      }
      cwd = prepared.worktreePath;
      host.repository.updateCheckout(checkout.id, {
        path: cwd,
        branch: prepared.branch,
        baseSha: prepared.baseHead,
      });
      const current = host.repository.getCheckout(checkout.id);
      if (current?.status === 'failed')
        host.repository.transitionCheckout(checkout.id, 'preparing');
      if (host.repository.getCheckout(checkout.id)?.status !== 'ready')
        host.repository.transitionCheckout(checkout.id, 'ready');
    }

    // Preparation is an irreversible Git side effect. A cancellation may
    // have won while it was pending, so never proceed to launch on stale
    // claimed state.
    const afterPreparation = host.repository.getRun(run.id);
    if (
      afterPreparation &&
      TERMINAL_RUN_STATUSES.includes(afterPreparation.status)
    ) {
      if (runtimeId) {
        terminalStopAttempted = true;
        await host.manager.stop(runtimeId, true);
      }
      if (freshPrepared) {
        const record = host.worktreeRecord(
          host.repository.getCheckout(checkout.id) ?? checkout,
        );
        const discarded = record
          ? await createWorktreeFinisher(
              host.storeFor(checkout),
            ).discardFreshWorktree(record.id)
          : {};
        if (!discarded.warning) {
          host.freshWorktreeRuns.delete(run.id);
          try {
            host.repository.transitionCheckout(checkout.id, 'retired');
          } catch {
            /* terminal cancellation remains durable */
          }
        }
      }
      return;
    }

    const anchor = host.workspaces().find((item) => {
      try {
        return (
          realpathSync.native(item.canonicalPath) === project.rootPath ||
          realpathSync.native(item.path) === project.rootPath
        );
      } catch {
        return (
          item.canonicalPath === project.rootPath ||
          item.path === project.rootPath
        );
      }
    });
    if (!anchor)
      throw new Error(
        'The project parent workspace is not available as a launch anchor.',
      );
    runtimeId = runtimeId ?? `runtime-${randomUUID()}`;
    host.repository.setRunRuntime(run.id, runtimeId);
    host.repository.transitionRun(run.id, 'starting');
    // Orchestration owns durable prompt delivery after hello. Do not route
    // the prompt through RuntimeManager's legacy memory-only launch path.
    await host.manager.launch({
      workspaceId: anchor.id,
      runtimeId,
      checkoutCwd: cwd,
      name: host.requireThread(run.threadId).title,
      mode: run.mode,
      model: run.model,
      runtimeProvider: run.runtimeProvider,
    });

    // Cancellation can race the provider start itself. The manager now
    // accepts stopping a managed launch before hello/registry registration.
    launchAttempted = true;
    const afterLaunch = host.repository.getRun(run.id);
    if (afterLaunch && TERMINAL_RUN_STATUSES.includes(afterLaunch.status)) {
      terminalStopAttempted = true;
      await host.manager.stop(runtimeId, true);
      if (freshPrepared) {
        const record = host.worktreeRecord(
          host.repository.getCheckout(checkout.id) ?? checkout,
        );
        const discarded = record
          ? await createWorktreeFinisher(
              host.storeFor(checkout),
            ).discardFreshWorktree(record.id)
          : {};
        if (!discarded.warning) {
          host.freshWorktreeRuns.delete(run.id);
          try {
            host.repository.transitionCheckout(checkout.id, 'retired');
          } catch {
            /* terminal cancellation remains durable */
          }
        }
      }
    } else if (freshPrepared) {
      // Once launch has succeeded and no terminal stop is required, later
      // cancellation must preserve model edits via finishWorktree().
      host.freshWorktreeRuns.delete(run.id);
    }
  } catch (error) {
    const current = host.repository.getRun(run.id);
    if (!current || !TERMINAL_RUN_STATUSES.includes(current.status))
      host.failRun(run.id, 'failed', errorText(error));
    // Do not swallow a provider failure while the manager still owns a
    // launch. The durable run error and retained provider/worktree evidence
    // make the same command retryable.
    const manager = host.manager as RuntimeManager & {
      hasLaunch?: (id: string) => boolean;
    };
    const retainedLaunch = runtimeId
      ? (manager.hasLaunch?.(runtimeId) ?? false)
      : false;
    if (retainedLaunch) {
      host.repository.setRunError(run.id, boundedErrorText(error));
      host.changed();
      throw error;
    }
    if (checkout.kind === 'worktree') {
      if (!terminalStopAttempted && !retainedLaunch) {
        const record = host.worktreeRecord(
          host.repository.getCheckout(checkout.id) ?? checkout,
        );
        if (record) {
          const discarded = await createWorktreeFinisher(
            host.storeFor(checkout),
          ).discardFreshWorktree(record.id);
          if (!discarded.warning) host.freshWorktreeRuns.delete(run.id);
        }
      }
      if (
        !current ||
        !TERMINAL_RUN_STATUSES.includes(current.status) ||
        (!terminalStopAttempted && !retainedLaunch && launchAttempted)
      ) {
        if (host.repository.getCheckout(checkout.id)?.status !== 'failed') {
          try {
            host.repository.transitionCheckout(checkout.id, 'failed');
          } catch {
            /* preserve error */
          }
        }
      }
    }
  }
  host.changed();
}
