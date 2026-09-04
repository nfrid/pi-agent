import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@pi-dashboard/domain';
import { createWorktreeFinisher } from '@pi-dashboard/worktree-manager';
import type { RegistryChange } from '../../runtime-registry.js';
import { boundedErrorText, type OrchestrationHost } from './helpers.js';

/** Registry callback is deliberately synchronous at the transport boundary. */
export function onRegistryChange(
  host: OrchestrationHost,
  change: RegistryChange,
): void {
  const task = handleRegistryChange(host, change);
  host.registryTasks.add(task);
  void task.then(
    () => host.registryTasks.delete(task),
    () => host.registryTasks.delete(task),
  );
}

export function handleRegistryChange(
  host: OrchestrationHost,
  change: RegistryChange,
): Promise<void> {
  const runtimeId =
    change.kind === 'registered' ||
    change.kind === 'offline' ||
    change.kind === 'removed'
      ? change.snapshot.runtimeId
      : change.runtimeId;
  const run = host.repository.getRunByRuntimeId(runtimeId);
  if (!run) return Promise.resolve();
  const prior = host.registryRunQueues.get(run.id) ?? Promise.resolve();
  const task = prior
    .catch(() => undefined)
    .then(() => reduceRegistryChange(host, run.id, runtimeId, change));
  host.registryRunQueues.set(run.id, task);
  void task.then(
    () => {
      if (host.registryRunQueues.get(run.id) === task)
        host.registryRunQueues.delete(run.id);
    },
    () => {
      if (host.registryRunQueues.get(run.id) === task)
        host.registryRunQueues.delete(run.id);
    },
  );
  return task;
}

export async function reduceRegistryChange(
  host: OrchestrationHost,
  runId: string,
  runtimeId: string,
  change: RegistryChange,
): Promise<void> {
  const run = host.repository.getRun(runId);
  if (!run) return;
  try {
    if (change.kind === 'registered') {
      await bindAndDeliverPrompt(
        host,
        run.id,
        runtimeId,
        change.snapshot.session.id,
      );
    } else if (change.kind === 'event') {
      const current = host.repository.getRun(run.id);
      const promptPending =
        current &&
        (current.status === 'preparing' || current.status === 'starting') &&
        !host.repository.getCommandReceipt(host.promptReceiptId(run.id));
      // The per-run queue lets events following a successful hello observe
      // its receipt. If the handoff failed, ignore prompt-driven lifecycle
      // events until a later hello retries successfully; otherwise a stale
      // settled event could complete work whose prompt was never durable.
      if (promptPending && change.event.type !== 'runtime.goodbye') return;
      if (change.event.type === 'agent.settled') await settle(host, run.id);
      else if (change.event.type === 'runtime.stateChanged') {
        const state = change.event.state;
        if (state === 'waiting') host.transitionIfPossible(run.id, 'waiting');
        else if (state === 'working')
          host.transitionIfPossible(run.id, 'running');
      } else if (
        change.event.type === 'runtime.goodbye' &&
        change.event.reason !== 'reload'
      ) {
        host.repository.stopRuntime(runtimeId);
        if (ACTIVE_RUN_STATUSES.includes(run.status))
          host.failRun(
            run.id,
            'interrupted',
            `Runtime exited before the run completed${change.event.reason ? ` (${change.event.reason})` : ''}.`,
          );
      }
    } else {
      host.repository.stopRuntime(runtimeId);
      if (ACTIVE_RUN_STATUSES.includes(run.status))
        host.failRun(
          run.id,
          'interrupted',
          'Runtime disconnected before the run completed.',
        );
    }
  } catch (error) {
    host.repository.setRunError(run.id, boundedErrorText(error));
  }
  host.changed();
  host.kick();
}

/**
 * A hello is the durable prompt handoff boundary. The receipt is written
 * only after RuntimeRegistry has acknowledged the command, so a reconnect
 * can safely retry the same stable command ID.
 */
export async function bindAndDeliverPrompt(
  host: OrchestrationHost,
  runId: string,
  runtimeId: string,
  piSessionId: string,
): Promise<void> {
  const run = host.repository.getRun(runId);
  if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) return;
  host.repository.bindRuntime({
    runtimeId,
    piSessionId,
    runId,
    status: 'starting',
  });
  const promptReceiptId = host.promptReceiptId(run.id);
  if (!host.repository.getCommandReceipt(promptReceiptId)) {
    if (run.model?.provider === 'openai-codex')
      await host.registry.sendCommand(runtimeId, {
        type: 'setModel',
        provider: run.model.provider,
        model: run.model.model,
        serviceTier: run.model.serviceTier ?? null,
      });
    const images = host.initialImages(run.id);
    if (run.error === 'Initial images pending delivery.' && !images)
      throw new Error(
        'Initial image attachments were lost before delivery; retry the draft.',
      );
    await host.registry.sendCommand(runtimeId, {
      id: promptReceiptId,
      type: 'prompt',
      text: run.initialPrompt,
      ...(images?.length ? { images } : {}),
    });
    host.saveReceipt(promptReceiptId, 'run.prompt', { runId: run.id });
  }
  await host.releaseInitialImages(run.id);
  // A prior ACK failure is no longer actionable once this retry was
  // acknowledged by the runtime.
  host.repository.clearRunError(run.id);
  const current = host.repository.getRun(runId);
  if (!current || TERMINAL_RUN_STATUSES.includes(current.status)) return;
  if (current.status === 'preparing')
    host.transitionIfPossible(runId, 'starting');
  if (host.repository.getRun(runId)?.status === 'starting')
    host.repository.transitionRun(runId, 'running');
  host.repository.transitionRuntime(runtimeId, 'running');
}

export async function settle(
  host: OrchestrationHost,
  runId: string,
): Promise<void> {
  const run = host.requireRun(runId);
  if (TERMINAL_RUN_STATUSES.includes(run.status)) return;
  const current = host.requireRun(runId);
  if (current.status === 'starting')
    host.transitionIfPossible(runId, 'running');
  if (
    host.requireRun(runId).status === 'waiting' ||
    host.requireRun(runId).status === 'running'
  )
    host.transitionIfPossible(runId, 'completed');
  const checkout = host.requireCheckout(run.checkoutId);
  if (checkout.kind === 'worktree') {
    const record = host.worktreeRecord(checkout);
    if (record) {
      await host.beforeWorktreeFinish?.();
      await createWorktreeFinisher(host.storeFor(checkout)).finishWorktree(
        record.id,
        {
          taskName: host.requireThread(run.threadId).title,
          outcome: 'success',
        },
      );
      host.repository.transitionCheckout(checkout.id, 'dirty');
      host.freshWorktreeRuns.delete(runId);
    }
  }
  if (run.runtimeId) {
    try {
      host.repository.transitionRuntime(run.runtimeId, 'stopped');
    } catch {
      /* already offline */
    }
  }
}
