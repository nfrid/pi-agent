import { TERMINAL_RUN_STATUSES } from '@pi-dashboard/domain';
import {
  createWorktreeFinisher,
  createWorktreeIntegrator,
} from '@pi-dashboard/worktree-manager';
import type { OrchestrationHost } from './helpers.js';

export async function reviewCheckout(
  host: OrchestrationHost,
  checkoutId: string,
): Promise<unknown> {
  const checkout = host.requireCheckout(checkoutId);
  const record = host.worktreeRecord(checkout);
  if (!record) throw new Error('Checkout has no prepared worktree record.');
  return createWorktreeIntegrator().reviewBranch(record);
}

export async function mergeCheckout(
  host: OrchestrationHost,
  checkoutId: string,
  commandId: string,
): Promise<unknown> {
  const prior = host.receipt(commandId, 'checkout.merge');
  if (prior) return prior.result;
  const active = host.mergeTasks.get(checkoutId);
  if (active) {
    if (active.commandId !== commandId)
      throw Object.assign(
        new Error('A different merge command already owns this checkout.'),
        { code: 'orchestration-conflict' },
      );
    return active.task;
  }
  const task = performMergeCheckout(host, checkoutId, commandId);
  host.mergeTasks.set(checkoutId, { commandId, task });
  void task.then(
    () => {
      if (host.mergeTasks.get(checkoutId)?.task === task)
        host.mergeTasks.delete(checkoutId);
    },
    () => {
      if (host.mergeTasks.get(checkoutId)?.task === task)
        host.mergeTasks.delete(checkoutId);
    },
  );
  return task;
}

export async function performMergeCheckout(
  host: OrchestrationHost,
  checkoutId: string,
  commandId: string,
): Promise<unknown> {
  const checkout = host.requireCheckout(checkoutId);
  host.assertCheckoutQuiescent(checkoutId);
  const record = host.worktreeRecord(checkout);
  if (!record) throw new Error('Checkout has no prepared worktree record.');
  const claimed = host.repository.claimCheckoutForMerge(checkoutId);
  if (!claimed) {
    const current = host.repository.getCheckout(checkoutId);
    throw Object.assign(
      new Error(
        current?.status === 'merging'
          ? 'Checkout merge is already owned by another command.'
          : `Checkout cannot be merged from ${current?.status ?? 'missing'} state.`,
      ),
      { code: 'orchestration-conflict' },
    );
  }
  try {
    // Stop any retained managed runtime before Git integration can mutate
    // main. A cleanup failure must leave both sides untouched and reviewable.
    await host.quiesceCheckoutRuntimes(checkoutId);
    const outcome = await createWorktreeIntegrator().mergeBranch(record);
    if (!outcome.merged) {
      host.repository.transitionCheckout(checkoutId, 'dirty');
      throw Object.assign(
        new Error(outcome.reason ?? 'Checkout merge failed.'),
        {
          code: 'merge-conflict',
          outcome,
        },
      );
    }
    await createWorktreeFinisher(host.storeFor(checkout)).removeWorktree(
      record.id,
    );
    const result = {
      checkout: host.repository.transitionCheckout(checkoutId, 'retired'),
      outcome,
    };
    host.saveReceipt(commandId, 'checkout.merge', result);
    host.changed();
    return result;
  } catch (error) {
    if (host.repository.getCheckout(checkoutId)?.status === 'merging')
      host.repository.transitionCheckout(checkoutId, 'dirty');
    host.changed();
    throw error;
  }
}

export async function retireCheckout(
  host: OrchestrationHost,
  checkoutId: string,
  commandId: string,
): Promise<unknown> {
  const prior = host.receipt(commandId, 'checkout.retire');
  if (prior) return prior.result;
  const checkout = host.requireCheckout(checkoutId);
  host.assertCheckoutQuiescent(checkoutId);
  if (checkout.kind === 'main') {
    throw Object.assign(new Error('The main checkout cannot be retired.'), {
      code: 'orchestration-conflict',
    });
  }
  if (checkout.kind !== 'worktree') {
    const result = host.repository.transitionCheckout(checkoutId, 'retired');
    host.saveReceipt(commandId, 'checkout.retire', result);
    host.changed();
    return result;
  }
  const record = host.worktreeRecord(checkout);
  await host.quiesceCheckoutRuntimes(checkoutId);
  if (record)
    await createWorktreeFinisher(host.storeFor(checkout)).removeWorktree(
      record.id,
    );
  const result = host.repository.transitionCheckout(checkoutId, 'retired');
  host.saveReceipt(commandId, 'checkout.retire', result);
  host.changed();
  return result;
}

export function assertCheckoutQuiescent(
  host: OrchestrationHost,
  checkoutId: string,
): void {
  const active = host.repository
    .listRuns()
    .filter(
      (run) =>
        run.checkoutId === checkoutId &&
        !TERMINAL_RUN_STATUSES.includes(run.status),
    );
  if (active.length > 0)
    throw Object.assign(
      new Error('A checkout with an active run cannot be changed.'),
      { code: 'orchestration-conflict' },
    );
}

export async function quiesceCheckoutRuntimes(
  host: OrchestrationHost,
  checkoutId: string,
): Promise<void> {
  const runtimeIds = new Set(
    host.repository
      .listRuns()
      .filter(
        (run) => run.checkoutId === checkoutId && run.runtimeId !== undefined,
      )
      .map((run) => run.runtimeId as string),
  );
  const manager = host.manager as typeof host.manager & {
    stopRecovered?: (id: string) => Promise<void>;
  };
  for (const runtimeId of runtimeIds) {
    const live = host.registry.get(runtimeId);
    if (live && live.online !== false) {
      await host.manager.stop(runtimeId, true);
    } else if (manager.stopRecovered) {
      await manager.stopRecovered(runtimeId);
    } else {
      await host.manager.stop(runtimeId, true);
    }
  }
}
