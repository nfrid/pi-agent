import type { BackgroundJobSnapshot } from '@pi-agent/background-jobs';
import { describe, expect, test, vi } from 'vitest';
import {
  type HostedCompletionAckClient,
  HostedCompletionAcker,
} from './hosted-completion-ack';
import {
  DelegateWorkflowCoordinator,
  type DelegateWorkflowMetadataHistory,
} from './workflow-coordinator';

const PROCESS_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';

function metadata(
  state: 'running' | 'success' = 'success',
  processJobId: string | null = PROCESS_JOB_ID,
): DelegateWorkflowMetadataHistory {
  const now = Date.now();
  return {
    version: 1,
    attempts: [
      {
        ownerBranchId: 'branch-hosted',
        logicalId: 'hosted',
        attempt: 1,
        identity: 'hosted@1',
        state,
        dependencies: [],
        waitingFor: [],
        createdAt: now,
        scheduledAt: now,
        queuedAt: now,
        startedAt: now,
        ...(state === 'success' ? { settledAt: now } : {}),
        ...(processJobId
          ? { sessionId: 'delegate-session', processJobId }
          : {}),
      },
    ],
  };
}

function hostJob(
  status: BackgroundJobSnapshot['status'] = 'done',
  completionDelivered = false,
): BackgroundJobSnapshot {
  return {
    id: PROCESS_JOB_ID,
    ownerSession: 'parent-session',
    title: 'hosted',
    command: 'pi',
    cwd: '/tmp',
    status,
    createdAt: Date.now(),
    completionDelivered,
    stdout: { text: '', totalBytes: 0, droppedBytes: 0 },
    stderr: { text: '', totalBytes: 0, droppedBytes: 0 },
  };
}

function setup(
  state: 'running' | 'success' = 'success',
  processJobId: string | null = PROCESS_JOB_ID,
) {
  const workflow = new DelegateWorkflowCoordinator();
  workflow.restoreMetadata(metadata(state, processJobId));
  const inspect = vi.fn<
    (id: string) => Promise<BackgroundJobSnapshot | undefined>
  >(async () => hostJob());
  const markDelivered = vi.fn(async () => undefined);
  const client: HostedCompletionAckClient = { inspect, markDelivered };
  const acker = new HostedCompletionAcker({
    ownerSessionId: 'parent-session',
    getWorkflow: () => workflow,
    client,
  });
  return { workflow, inspect, markDelivered, acker };
}

describe('hosted completion acknowledgement', () => {
  test('acknowledges a terminal linked attempt only when its source enters', async () => {
    const { acker, inspect, markDelivered } = setup();
    expect(inspect).not.toHaveBeenCalled();
    await acker.entered(['hosted@1']);
    expect(inspect).toHaveBeenCalledWith(PROCESS_JOB_ID);
    expect(markDelivered).toHaveBeenCalledWith(PROCESS_JOB_ID);
  });

  test('does not acknowledge running, unknown, or unlinked attempts', async () => {
    const running = setup('running');
    await running.acker.entered(['hosted@1']);
    expect(running.inspect).not.toHaveBeenCalled();

    const unlinked = setup('success', null);
    await unlinked.acker.entered(['hosted@1', 'missing@1']);
    expect(unlinked.inspect).not.toHaveBeenCalled();
  });

  test('does not acknowledge a running or unknown host row', async () => {
    const running = setup();
    running.inspect.mockResolvedValue(hostJob('running'));
    await running.acker.entered(['hosted@1']);
    expect(running.markDelivered).not.toHaveBeenCalled();

    const unknown = setup();
    unknown.inspect.mockResolvedValue(undefined);
    await unknown.acker.entered(['hosted@1']);
    expect(unknown.markDelivered).not.toHaveBeenCalled();
  });

  test('deduplicates concurrent and repeated entered wakes by process job ID', async () => {
    const { acker, inspect, markDelivered } = setup();
    let resolveInspect: ((job: BackgroundJobSnapshot) => void) | undefined;
    inspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInspect = resolve;
        }),
    );
    const first = acker.entered(['hosted@1']);
    const second = acker.entered(['hosted@1', 'hosted@1']);
    resolveInspect?.(hostJob());
    await Promise.all([first, second]);
    await acker.entered(['hosted@1']);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(markDelivered).toHaveBeenCalledTimes(1);
  });

  test('treats an already delivered host row as successful deduplication', async () => {
    const { acker, inspect, markDelivered } = setup();
    inspect.mockResolvedValue(hostJob('done', true));
    await acker.entered(['hosted@1']);
    await acker.entered(['hosted@1']);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(markDelivered).not.toHaveBeenCalled();
  });

  test('retries transient inspect and acknowledgement failures', async () => {
    const inspectFailure = setup();
    inspectFailure.inspect.mockRejectedValueOnce(
      new Error('socket unavailable'),
    );
    await expect(inspectFailure.acker.entered(['hosted@1'])).rejects.toThrow(
      'socket unavailable',
    );
    await inspectFailure.acker.entered(['hosted@1']);
    expect(inspectFailure.markDelivered).toHaveBeenCalledTimes(1);

    const ackFailure = setup();
    ackFailure.markDelivered.mockRejectedValueOnce(new Error('socket reset'));
    await expect(ackFailure.acker.entered(['hosted@1'])).rejects.toThrow(
      'socket reset',
    );
    // A failed ACK remains retryable, but unrelated context sources do not
    // select the previously failed process job.
    await ackFailure.acker.entered(['unrelated@1']);
    expect(ackFailure.inspect).toHaveBeenCalledTimes(1);
    expect(ackFailure.markDelivered).toHaveBeenCalledTimes(1);
    await ackFailure.acker.entered(['hosted@1']);
    expect(ackFailure.inspect).toHaveBeenCalledTimes(2);
    expect(ackFailure.markDelivered).toHaveBeenCalledTimes(2);
  });
});
