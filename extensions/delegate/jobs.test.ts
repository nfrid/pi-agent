import { describe, expect, test, vi } from 'vitest';
import { processJsonLine } from './events';
import {
  DelegateJobManager,
  type DelegateJobResult,
  MAX_DELEGATE_JOBS,
} from './jobs';
import {
  LIFECYCLE_INLINE_DIAGNOSTIC_BYTES,
  LIFECYCLE_PUBLIC_FALLBACK_MARKER,
  setDelegateLifecycle,
  setDelegateLifecycleDiagnosticArtifact,
} from './lifecycle';
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

  test('persists bounded thinking and normal tool payloads in job snapshots', async () => {
    const result = successfulResult('persist execution');
    const run = result.runs[0];
    if (!run) throw new Error('missing run');
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'job thinking',
        },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'job-tool',
        toolName: 'bash',
        args: { command: 'printf job' },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'job-tool',
        toolName: 'bash',
        result: { output: 'job output', exitCode: 0 },
      }),
      run,
    );
    const manager = new DelegateJobManager();
    const started = manager.start({
      mode: 'single',
      tasks: [run.task],
      execute: async () => result,
    });
    const settled = await manager.peek(started.id, 1_000);
    const persisted = settled.runs?.[0];
    expect(persisted?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          transcriptText: 'job thinking',
        }),
        expect.objectContaining({
          toolArguments: { command: 'printf job' },
          toolResult: { output: 'job output', exitCode: 0 },
        }),
      ]),
    );
    await manager.dispose();
  });

  test('re-materializes a retained result on deliberate inspection', async () => {
    const materialize = vi.fn(async (_ctx, runs) => ({
      runs,
      handoff: 'published exact report',
    }));
    const manager = new DelegateJobManager();
    const started = manager.start({
      mode: 'single',
      tasks: ['inspect'],
      execute: async () => successfulResult(),
      materialize,
    });
    await vi.waitFor(() => expect(manager.runningCount).toBe(0));

    const inspected = await manager.materialize(started.id, {
      sessionManager: { getSessionId: () => 'session-one' },
    } as never);
    expect(materialize).toHaveBeenCalledOnce();
    expect(inspected.handoff).toBe('published exact report');
    expect(inspected.runs?.[0]?.messages).toHaveLength(1);
    await manager.dispose();
  });

  test('keeps one bounded captured diagnostic in a stale-session peek', async () => {
    const diagnostic = `actionable failure ${'x'.repeat(3_000)}`;
    const run = createRun('stale failure');
    run.state = 'error';
    run.exitCode = 9;
    run.stderr = 'raw stderr must not be used as the stale fallback';
    setDelegateLifecycle(run, 'child-nonzero-exit', diagnostic);
    const ownerHandle = `art_${'o'.repeat(22)}`;
    setDelegateLifecycleDiagnosticArtifact(run, {
      handle: ownerHandle,
      sha256: 'a'.repeat(64),
      size: Buffer.byteLength(diagnostic, 'utf8'),
      producer: 'delegate',
      contentClass: 'delegate-output',
      creationSource: 'delegate.failure',
      encoding: 'utf-8',
      lineCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const manager = new DelegateJobManager();
    const started = manager.start({
      ownerSessionId: 'owner-session',
      mode: 'single',
      tasks: [run.task],
      execute: async () => ({ runs: [run], handoff: 'owner-only handoff' }),
    });
    await vi.waitFor(() => expect(manager.runningCount).toBe(0));

    const stale = await manager.peek(started.id, 0, undefined, {
      sessionManager: { getSessionId: () => 'stale-session' },
    } as never);
    const projection = stale.runs?.[0]?.lifecycle;
    expect(projection?.reason).toBe('child-nonzero-exit');
    expect(projection?.diagnostic).not.toBe(diagnostic);
    expect(projection?.diagnostic).toContain(LIFECYCLE_PUBLIC_FALLBACK_MARKER);
    expect(
      Buffer.byteLength(projection?.diagnostic ?? '', 'utf8'),
    ).toBeLessThanOrEqual(LIFECYCLE_INLINE_DIAGNOSTIC_BYTES);
    expect(projection?.diagnosticArtifact).toBeUndefined();
    expect(
      JSON.stringify(stale).match(/actionable failure/g) ?? [],
    ).toHaveLength(1);
    expect(JSON.stringify(stale)).not.toContain('raw stderr');
    expect(JSON.stringify(stale)).not.toContain(ownerHandle);
    expect(stale.handoff).toBeUndefined();
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
    expect(jobs.map((job) => job.tasks)).toEqual([['first'], ['second']]);
    await vi.waitFor(() => expect(manager.runningCount).toBe(0));
    await manager.dispose();
  });

  test('retains optional workflow identity separately from opaque job IDs', async () => {
    const manager = new DelegateJobManager();
    const started = manager.start({
      mode: 'single',
      tasks: ['inspect'],
      workflowAttempt: {
        logicalId: 'impl',
        ordinal: 1,
        identity: 'impl@1',
      },
      execute: async () => successfulResult(),
    });

    expect(started).toMatchObject({
      id: 'dj-1',
      logicalId: 'impl',
      attemptIdentity: 'impl@1',
    });
    await vi.waitFor(() => expect(manager.runningCount).toBe(0));
    expect(manager.get(started.id)).toMatchObject({
      id: 'dj-1',
      logicalId: 'impl',
      attemptIdentity: 'impl@1',
    });
    await manager.dispose();
  });

  test('rejects malformed workflow identity before entering job snapshots', () => {
    const manager = new DelegateJobManager();
    const execute = async () => successfulResult();
    expect(() =>
      manager.start({
        mode: 'single',
        tasks: ['inspect'],
        workflowAttempt: {
          logicalId: 'impl',
          ordinal: 1,
          identity: 'wrong@1',
        },
        execute,
      }),
    ).toThrow(/logical ID, ordinal, and identity must agree/);
    expect(() =>
      manager.start({
        mode: 'single',
        tasks: ['inspect'],
        workflowAttempt: {
          logicalId: 'Impl',
          ordinal: 1,
          identity: 'Impl@1',
        },
        execute,
      }),
    ).toThrow(/logical ID, ordinal, and identity must agree/);
    expect(manager.list()).toEqual([]);
    expect(() =>
      createRun('inspect', undefined, {
        workflowAttempt: {
          logicalId: 'impl',
          ordinal: 1,
          identity: 'impl@2',
        },
      }),
    ).toThrow(/logical ID, ordinal, and identity must agree/);
  });

  test('retains workflow identity when execution throws', async () => {
    const manager = new DelegateJobManager();
    const started = manager.start({
      mode: 'single',
      tasks: ['inspect'],
      workflowAttempt: {
        logicalId: 'impl',
        ordinal: 1,
        identity: 'impl@1',
      },
      execute: async () => {
        throw new Error('launch failed');
      },
    });

    const settled = await manager.peek(started.id, 1_000);
    expect(settled).toMatchObject({
      state: 'error',
      logicalId: 'impl',
      attemptIdentity: 'impl@1',
      runs: [
        {
          workflowAttempt: {
            logicalId: 'impl',
            ordinal: 1,
            identity: 'impl@1',
          },
        },
      ],
    });
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

  test('queues bounded feedback only while a job is active', async () => {
    const feedback = vi.fn(() => ({ accepted: true, id: 'feedback-1' }));
    let reject!: (error: unknown) => void;
    const manager = new DelegateJobManager();
    const started = manager.start({
      mode: 'single',
      tasks: ['steer me'],
      feedback,
      execute: () =>
        new Promise<DelegateJobResult>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    });

    expect(
      manager.sendFeedback(started.id, 'Fix the omitted interface.'),
    ).toEqual(expect.objectContaining({ delivery: 'queued' }));
    expect(feedback).toHaveBeenCalledWith('Fix the omitted interface.');
    reject(new Error('stop test job'));
    await vi.waitFor(() => expect(manager.runningCount).toBe(0));
    expect(manager.sendFeedback(started.id, 'too late').delivery).toBe(
      'settled',
    );
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
