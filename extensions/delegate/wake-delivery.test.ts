import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, test, vi } from 'vitest';
import { createRun } from './types';
import { WakeCoordinator } from './wake-coordinator';
import {
  createWakeDelivery,
  DELEGATE_WAKE_MESSAGE_TYPE,
} from './wake-delivery';
import { DelegateWorkflowCoordinator } from './workflow-coordinator';

function result(): { runs: ReturnType<typeof createRun>[]; handoff: string } {
  const run = createRun('wake source');
  run.state = 'success';
  run.exitCode = 0;
  run.finishedAt = Date.now();
  return { runs: [run], handoff: 'bounded handoff evidence' };
}

describe('wake delivery', () => {
  test('uses steer by default and acknowledges only when the custom message enters context', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const attempt = workflow.schedule({
      logicalId: 'source',
      mode: 'single',
      tasks: ['source'],
      execute: async () => result(),
    });
    await vi.waitFor(() =>
      expect(workflow.require(attempt.identity).settledAt).toBeDefined(),
    );
    const sendMessage = vi.fn();
    const pi = { sendMessage } as unknown as ExtensionAPI;
    let active: WakeCoordinator | undefined;
    const delivery = createWakeDelivery({
      pi,
      getRuntimeActive: () => true,
      getActiveCoordinator: () => active,
    });
    active = new WakeCoordinator({
      workflow,
      ownerSessionId: 'session',
      ownerEpoch: 3,
      dispatch: delivery.dispatch,
    });
    active.register({ id: 'ready', condition: { node: attempt.identity } });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: DELEGATE_WAKE_MESSAGE_TYPE,
        details: expect.objectContaining({
          dedupeKey: 'session:3:ready',
          deliveryKey: 'session:3:ready',
        }),
      }),
      { deliverAs: 'steer', triggerTurn: true },
    );
    expect(active.require('ready').state).toBe('queued');
    const message = sendMessage.mock.calls[0]?.[0];
    delivery.markContextEntered([message, message]);
    expect(active.require('ready').state).toBe('entered');
    await workflow.dispose();
  });

  test('uses followUp only for an explicitly non-obstructive wake', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const attempt = workflow.schedule({
      logicalId: 'later-source',
      mode: 'single',
      tasks: ['later-source'],
      execute: async () => result(),
    });
    await vi.waitFor(() =>
      expect(workflow.require(attempt.identity).settledAt).toBeDefined(),
    );
    const sendMessage = vi.fn();
    let active: WakeCoordinator | undefined;
    const delivery = createWakeDelivery({
      pi: { sendMessage } as unknown as ExtensionAPI,
      getRuntimeActive: () => true,
      getActiveCoordinator: () => active,
    });
    active = new WakeCoordinator({
      workflow,
      ownerSessionId: 'session-later',
      dispatch: delivery.dispatch,
    });
    active.register({
      id: 'later',
      condition: { node: attempt.identity },
      nonObstructive: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: DELEGATE_WAKE_MESSAGE_TYPE }),
      { deliverAs: 'followUp', triggerTurn: true },
    );
    await workflow.dispose();
  });

  test('restores a queued message once and rejects forged metadata', async () => {
    const sourceWorkflow = new DelegateWorkflowCoordinator();
    const attempt = sourceWorkflow.schedule({
      logicalId: 'reload-source',
      mode: 'single',
      tasks: ['reload-source'],
      execute: async () => result(),
    });
    await vi.waitFor(() =>
      expect(sourceWorkflow.require(attempt.identity).settledAt).toBeDefined(),
    );
    const sendMessage = vi.fn();
    let source: WakeCoordinator | undefined;
    const sourceDelivery = createWakeDelivery({
      pi: { sendMessage } as unknown as ExtensionAPI,
      getRuntimeActive: () => true,
      getActiveCoordinator: () => source,
    });
    source = new WakeCoordinator({
      workflow: sourceWorkflow,
      ownerSessionId: 'reload-session',
      ownerEpoch: 5,
      dispatch: sourceDelivery.dispatch,
    });
    source.register({
      id: 'reload-wake',
      condition: { node: attempt.identity },
    });
    const message = sendMessage.mock.calls[0]?.[0];
    if (!message) throw new Error('missing queued wake message');

    const restoredWorkflow = new DelegateWorkflowCoordinator();
    let restored: WakeCoordinator | undefined;
    const restoredDelivery = createWakeDelivery({
      pi: { sendMessage: vi.fn() } as unknown as ExtensionAPI,
      getRuntimeActive: () => true,
      getActiveCoordinator: () => restored,
    });
    restored = new WakeCoordinator({
      workflow: restoredWorkflow,
      ownerSessionId: 'reload-session',
      ownerEpoch: 5,
    });
    restored.restore(source.snapshot());

    const details = message.details as Record<string, unknown>;
    const acknowledgement = details.acknowledgement as Record<string, unknown>;
    const forged = [
      { ...message, details: { ...details, ownerSessionId: 'foreign' } },
      { ...message, details: { ...details, ownerEpoch: 6 } },
      {
        ...message,
        details: {
          ...details,
          acknowledgement: { ...acknowledgement, dispatchGeneration: 2 },
        },
      },
      {
        ...message,
        details: {
          ...details,
          acknowledgement: { ...acknowledgement, dispatchAttempt: 2 },
        },
      },
      { ...message, details: { ...details, sources: ['foreign@1'] } },
    ];
    for (const candidate of forged)
      expect(restoredDelivery.filterContext([candidate])).toEqual([]);
    expect(restored.require('reload-wake').state).toBe('queued');
    expect(restoredDelivery.filterContext([message])).toEqual([message]);
    expect(restored.require('reload-wake').state).toBe('entered');
    expect(restoredDelivery.filterContext([message])).toEqual([]);

    await sourceWorkflow.dispose();
    await restoredWorkflow.dispose();
  });

  test('filters stale recovery attempts before provider context', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const attempt = workflow.schedule({
      logicalId: 'source',
      mode: 'single',
      tasks: ['source'],
      execute: async () => result(),
    });
    await vi.waitFor(() =>
      expect(workflow.require(attempt.identity).settledAt).toBeDefined(),
    );
    const sendMessage = vi.fn();
    const entered = vi.fn();
    let active: WakeCoordinator | undefined;
    const delivery = createWakeDelivery({
      pi: { sendMessage } as unknown as ExtensionAPI,
      getRuntimeActive: () => true,
      getActiveCoordinator: () => active,
      onEntered: entered,
    });
    active = new WakeCoordinator({
      workflow,
      ownerSessionId: 'session',
      ownerEpoch: 4,
      dispatch: delivery.dispatch,
    });
    active.register({
      id: 'recoverable',
      condition: { node: attempt.identity },
    });
    const first = sendMessage.mock.calls[0]?.[0];
    active.recover('recoverable');
    const second = sendMessage.mock.calls[1]?.[0];
    const foreign = {
      customType: DELEGATE_WAKE_MESSAGE_TYPE,
      details: { deliveryKey: 'foreign:1:wake' },
    };

    expect(delivery.filterContext([foreign, first, second, second])).toEqual([
      second,
    ]);
    expect(active.require('recoverable').state).toBe('entered');
    expect(entered).toHaveBeenCalledOnce();
    expect(entered).toHaveBeenCalledWith(
      [attempt.identity],
      expect.objectContaining({ id: 'recoverable', state: 'entered' }),
    );
    await workflow.dispose();
  });

  test('leaves a failed dispatch recoverable', async () => {
    const workflow = new DelegateWorkflowCoordinator();
    const attempt = workflow.schedule({
      logicalId: 'source',
      mode: 'single',
      tasks: ['source'],
      execute: async () => result(),
    });
    await vi.waitFor(() =>
      expect(workflow.require(attempt.identity).settledAt).toBeDefined(),
    );
    const active = new WakeCoordinator({ workflow });
    const delivery = createWakeDelivery({
      pi: {
        sendMessage: vi.fn(() => {
          throw new Error('queue unavailable');
        }),
      } as unknown as ExtensionAPI,
      getRuntimeActive: () => true,
      getActiveCoordinator: () => active,
    });
    active.setDispatchHandler(delivery.dispatch);
    active.register({ id: 'retry', condition: { node: attempt.identity } });
    expect(active.require('retry').state).toBe('ready');
    expect(active.retry('retry').state).toBe('ready');
    expect(active.require('retry').dispatchAttempts).toBe(2);
    await workflow.dispose();
  });
});
