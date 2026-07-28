import { describe, expect, test, vi } from 'vitest';
import {
  DelegateJobManager,
  type DelegateJobResult,
  MAX_DELEGATE_JOBS,
} from './jobs';
import { createRun } from './types';

function successfulResult(task = 'inspect'): DelegateJobResult {
  const run = createRun(task, undefined, { continuation: 'token' });
  run.exitCode = 0;
  run.state = 'success';
  run.finishedAt = Date.now();
  run.messages = [
    {
      role: 'assistant',
      api: 'openai-responses',
      provider: 'test',
      model: 'test',
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  ];
  return { runs: [run], handoff: 'Delegated task succeeded\n\ndone' };
}

describe('DelegateJobManager', () => {
  test('runs asynchronously and retains the settled result', async () => {
    let finish!: (result: DelegateJobResult) => void;
    const execute = vi.fn(
      () =>
        new Promise<DelegateJobResult>((resolve) => {
          finish = resolve;
        }),
    );
    const onSettled = vi.fn();
    const manager = new DelegateJobManager({ onSettled });

    const started = manager.start({
      mode: 'single',
      tasks: ['inspect'],
      deliveryEpoch: 3,
      execute,
    });
    expect(started).toMatchObject({
      id: 'dj-1',
      state: 'running',
      tasks: ['inspect'],
      deliveryEpoch: 3,
    });
    expect(manager.runningCount).toBe(1);

    finish(successfulResult());
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(manager.get('dj-1')).toMatchObject({
      state: 'success',
      handoff: expect.stringContaining('succeeded'),
    });
    expect(manager.runningCount).toBe(0);
    await manager.dispose();
  });

  test('starts a batch atomically as independent jobs', async () => {
    const manager = new DelegateJobManager();
    const jobs = manager.startMany([
      {
        mode: 'single',
        tasks: ['first'],
        execute: async () => successfulResult('first'),
      },
      {
        mode: 'single',
        tasks: ['second'],
        execute: async () => successfulResult('second'),
      },
    ]);
    expect(jobs.map((job) => job.id)).toEqual(['dj-1', 'dj-2']);
    expect(jobs[0]?.cohortId).toBe(jobs[1]?.cohortId);
    expect(jobs.map((job) => job.tasks)).toEqual([['first'], ['second']]);
    await vi.waitFor(() => expect(manager.runningCount).toBe(0));
    await manager.dispose();
  });

  test('delivers only unobserved members once an observed member settles', async () => {
    let finishObserved!: (result: DelegateJobResult) => void;
    let finishUnobserved!: (result: DelegateJobResult) => void;
    const onSettled = vi.fn();
    const manager = new DelegateJobManager({ onSettled });
    const [observed, unobserved] = manager.startMany([
      {
        mode: 'single',
        tasks: ['observed'],
        execute: () =>
          new Promise<DelegateJobResult>((resolve) => {
            finishObserved = resolve;
          }),
      },
      {
        mode: 'single',
        tasks: ['unobserved'],
        execute: () =>
          new Promise<DelegateJobResult>((resolve) => {
            finishUnobserved = resolve;
          }),
      },
    ]);
    const waiting = manager.peek(observed.id, 1_000);
    finishUnobserved(successfulResult('unobserved'));
    finishObserved(successfulResult('observed'));
    await waiting;
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(onSettled.mock.calls[0]?.[0]).toHaveLength(1);
    expect(onSettled.mock.calls[0]?.[0][0]?.id).toBe(unobserved.id);
    await manager.dispose();
  });

  test('does not auto-deliver a result returned by a waiting peek', async () => {
    let finish!: (result: DelegateJobResult) => void;
    const onSettled = vi.fn();
    const manager = new DelegateJobManager({ onSettled });
    const started = manager.start({
      mode: 'single',
      tasks: ['inspect'],
      execute: () =>
        new Promise<DelegateJobResult>((resolve) => {
          finish = resolve;
        }),
    });

    const waiting = manager.peek(started.id, 1_000);
    finish(successfulResult());
    await expect(waiting).resolves.toMatchObject({ state: 'success' });
    expect(onSettled).not.toHaveBeenCalled();
    await manager.dispose();
  });

  test('cancels with a manager-owned abort signal', async () => {
    const onSettled = vi.fn();
    const manager = new DelegateJobManager({ onSettled });
    const started = manager.start({
      mode: 'single',
      tasks: ['wait'],
      execute: (signal) =>
        new Promise<DelegateJobResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    });

    const [cancelled] = await manager.cancel([started.id]);
    expect(cancelled.state).toBe('aborted');
    expect(cancelled.error).toContain('cancelled');
    expect(onSettled).not.toHaveBeenCalled();
    await manager.dispose();
  });

  test('bounds concurrent jobs and suppresses delivery during disposal', async () => {
    const onSettled = vi.fn();
    const manager = new DelegateJobManager({ onSettled });
    const never = (signal: AbortSignal) =>
      new Promise<DelegateJobResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });

    for (let index = 0; index < MAX_DELEGATE_JOBS; index++)
      manager.start({
        mode: 'single',
        tasks: [`task ${index}`],
        execute: never,
      });
    expect(() =>
      manager.start({ mode: 'single', tasks: ['extra'], execute: never }),
    ).toThrow(`At most ${MAX_DELEGATE_JOBS}`);

    await manager.dispose();
    expect(onSettled).not.toHaveBeenCalled();
    expect(manager.list()).toEqual([]);
  });
});
