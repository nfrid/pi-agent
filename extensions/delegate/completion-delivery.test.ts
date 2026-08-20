import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  COMPLETION_WAVE_BURST_MS,
  createCompletionDelivery,
} from './completion-delivery';
import type { DelegateJobSnapshot } from './jobs';

afterEach(() => {
  vi.useRealTimers();
});

describe('delegate completion delivery while paused', () => {
  test('retains completions until resume flushes them once', async () => {
    vi.useFakeTimers();
    let paused = true;
    const sendMessage = vi.fn();
    const delivery = createCompletionDelivery({
      pi: { sendMessage } as unknown as ExtensionAPI,
      getRuntimeActive: () => true,
      getDeliveryEpoch: () => 0,
      getRunningCount: () => 0,
      getStatuses: () => undefined,
      getUi: () => undefined,
      getPaused: () => paused,
    });
    const job: DelegateJobSnapshot = {
      id: 'dj-1',
      name: 'Paused child',
      mode: 'single',
      state: 'success',
      tasks: ['work'],
      createdAt: 1,
      settledAt: 2,
      deliveryEpoch: 0,
      handoff: 'done',
    };

    delivery.queueCompletion(job);
    await vi.advanceTimersByTimeAsync(COMPLETION_WAVE_BURST_MS);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(delivery.pendingCount()).toBe(1);

    paused = false;
    delivery.flushCompletions();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: 'delegate-job-result',
      details: { dedupeKey: 'dj-1', jobs: [{ id: 'dj-1' }] },
    });
    delivery.flushCompletions();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  test('filters a drained automatic completion after its tree epoch expires', () => {
    let epoch = 4;
    const delivery = createCompletionDelivery({
      pi: { sendMessage: vi.fn() } as unknown as ExtensionAPI,
      getRuntimeActive: () => true,
      getDeliveryEpoch: () => epoch,
      getRunningCount: () => 0,
      getStatuses: () => undefined,
      getUi: () => undefined,
    });
    const message = {
      customType: 'delegate-job-result',
      details: { jobs: [{ id: 'dj-old', deliveryEpoch: 4 }] },
    };

    expect(delivery.filterContext([message])).toEqual([message]);
    epoch = 5;
    expect(delivery.filterContext([message])).toEqual([]);
  });
});
