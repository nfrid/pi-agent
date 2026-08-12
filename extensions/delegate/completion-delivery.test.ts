import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  COMPLETION_WAVE_BURST_MS,
  createCompletionDelivery,
} from './completion-delivery';
import type { DelegateJobSnapshot } from './jobs';
import { createRun } from './types';

afterEach(() => {
  vi.useRealTimers();
});

describe('delegate completion delivery while paused', () => {
  test('bounds aggregate structured values in completion details', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn();
    const first = createRun('first');
    first.state = 'success';
    first.structuredResult = {
      valid: true,
      value: { visible: 'a'.repeat(40 * 1024) },
      errors: [],
    };
    const second = createRun('second');
    second.state = 'success';
    second.structuredResult = {
      valid: true,
      value: { visible: 'b'.repeat(40 * 1024) },
      errors: [],
    };
    const delivery = createCompletionDelivery({
      pi: { sendMessage } as unknown as ExtensionAPI,
      getRuntimeActive: () => true,
      getDeliveryEpoch: () => 0,
      getRunningCount: () => 0,
      getStatuses: () => undefined,
      getUi: () => undefined,
    });
    const job: DelegateJobSnapshot = {
      id: 'dj-bounded',
      name: 'Bounded batch',
      mode: 'parallel',
      state: 'success',
      tasks: ['first', 'second'],
      createdAt: 1,
      settledAt: 2,
      deliveryEpoch: 0,
      handoff: 'bounded',
      runs: [first, second],
    };

    delivery.queueCompletion(job);
    await vi.advanceTimersByTimeAsync(COMPLETION_WAVE_BURST_MS);
    const details = sendMessage.mock.calls[0]?.[0]?.details as {
      jobs?: Array<{ runs?: Array<{ structuredResult?: unknown }> }>;
    };
    expect(details.jobs?.[0]?.runs?.[0]?.structuredResult).toMatchObject({
      valid: true,
      value: { visible: 'a'.repeat(40 * 1024) },
    });
    expect(details.jobs?.[0]?.runs?.[1]?.structuredResult).toMatchObject({
      valid: true,
      valueOmitted: true,
    });
    expect(JSON.stringify(details)).not.toContain('b'.repeat(40 * 1024));
  });

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
      details: { jobs: [{ id: 'dj-1' }] },
    });
    delivery.flushCompletions();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
