import { describe, expect, test, vi } from 'vitest';
import { DelegateStatusStore } from './status';
import { createRun } from './types';

describe('delegate status store', () => {
  test('tracks live activity without retaining completed subagents', () => {
    const onChange = vi.fn();
    const store = new DelegateStatusStore(onChange);
    const run = createRun(
      'A very long task that is not used as the label',
      undefined,
      {
        name: 'Audit for regressions',
        sessionId: 'child-session-1',
      },
    );
    run.routing = {
      route: 'terra-high',
      provider: 'test',
      model: 'test-model',
      thinking: 'high',
      relativeCost: 1,
    };
    run.context = 'branch';
    const [id] = store.start([run], 'foreground');

    expect(store.list()).toMatchObject([
      {
        id,
        runId: run.runId,
        sessionId: 'child-session-1',
        lineageId: id,
        name: 'Audit for regressions',
        kind: 'foreground',
        state: 'queued',
        route: 'terra-high',
        context: 'branch',
        allowWrites: false,
      },
    ]);

    run.state = 'running';
    run.startedAt = Date.now();
    run.context = 'continuation';
    run.allowWrites = true;
    const activity = {
      type: 'thinking' as const,
      label: 'thinking',
      status: 'running' as const,
      startedAt: run.startedAt,
    };
    Object.defineProperty(activity, 'latestText', {
      value: 'Checking the changed execution paths',
      enumerable: false,
    });
    run.activities.push(activity);
    run.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'The audit is complete.' }],
      timestamp: run.startedAt + 1,
    } as never);
    store.update(id, run);
    expect(store.list()[0]).toMatchObject({
      state: 'running',
      route: 'terra-high',
      context: 'continuation',
      allowWrites: true,
      activity: {
        type: 'thinking',
        latestText: 'Checking the changed execution paths',
      },
      transcript: [
        {
          type: 'task',
          text: 'A very long task that is not used as the label',
        },
        {
          type: 'thinking',
          text: 'Checking the changed execution paths',
        },
        { type: 'assistant', text: 'The audit is complete.' },
      ],
    });

    store.finish([id]);
    expect(store.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  test('projects structured inspector details before and during execution', () => {
    const store = new DelegateStatusStore();
    const run = createRun('Inspect the live delegate setup', undefined, {
      cwd: '/repo/worktree',
      context: 'fresh',
      contextNote: 'Parent selected the focused checkout.',
      isolation: 'worktree',
      scope: ['extensions/delegate'],
      refreshSource: 'head',
      inputEvidence: [
        {
          identity: 'report@1',
          kind: 'report',
          label: 'Prior report',
          content: 'bounded evidence',
        },
      ],
      warnings: ['setup used a fallback'],
      worktree: {
        id: 'worktree-live-details',
        branch: 'pi/live-details',
        worktreePath: '/repo/worktree',
        repositoryRoot: '/repo',
        baseHead: 'abc123',
        workBase: 'abc123',
        status: 'active',
        hasWork: false,
      },
    });
    const [id] = store.start([run], 'background');
    expect(store.list()[0]?.details).toMatchObject({
      task: 'Inspect the live delegate setup',
      setup: {
        cwd: '/repo/worktree',
        isolation: 'worktree',
        worktree: { branch: 'pi/live-details' },
      },
      runConfig: {
        scope: ['extensions/delegate'],
        inputs: [{ identity: 'report@1', content: 'bounded evidence' }],
        parentContextNote: 'Parent selected the focused checkout.',
        refreshSource: 'head',
        warnings: ['setup used a fallback'],
      },
      truncated: false,
    });

    run.state = 'running';
    run.renderedPrompt = 'exact rendered prompt';
    store.update(id, run);
    expect(store.list()[0]).toMatchObject({
      state: 'running',
      details: { renderedPrompt: 'exact rendered prompt' },
    });
  });

  test('tracks per-delegate pausing and reached pause timestamps', () => {
    const store = new DelegateStatusStore();
    const run = createRun('pause me');
    const [id] = store.start([run], 'background');

    store.setPauseState(id, 'pausing', 10_000);
    expect(store.list()[0]).toMatchObject({
      pauseState: 'pausing',
      pausedAt: 10_000,
    });

    store.setPauseState(id, 'paused', 12_345);
    expect(store.list()[0]).toMatchObject({
      pauseState: 'paused',
      pausedAt: 12_345,
    });

    store.setPauseState(id, undefined);
    expect(store.list()[0]?.pauseState).toBeUndefined();
    expect(store.list()[0]?.pausedAt).toBeUndefined();
  });

  test('clears an entered result only on the first user message after settlement', () => {
    const store = new DelegateStatusStore();
    const run = createRun('audit');
    const [id] = store.start([run], 'foreground');

    run.state = 'success';
    store.update(id, run);
    store.parentSettled();
    store.parentUserMessage();
    expect(store.list()).toHaveLength(1);

    store.resultEntered([id]);
    store.parentSettled();
    expect(store.list()).toHaveLength(1);

    store.parentUserMessage();
    expect(store.list()).toEqual([]);
  });

  test('does not replace a specific terminal run state with its aggregate job state', () => {
    const store = new DelegateStatusStore();
    const run = createRun('audit');
    const [id] = store.start([run], 'background');
    store.setJobId(id, 'dj-1');

    run.state = 'timed-out';
    store.update(id, run);
    store.settleJobs([{ id: 'dj-1', state: 'error' }]);

    expect(store.list()[0]?.state).toBe('timed-out');
  });

  test('requires explicit inspection before a stale background completion can be acknowledged', () => {
    const store = new DelegateStatusStore();
    const run = createRun('audit');
    run.state = 'success';
    const [id] = store.start([run], 'background');
    store.setJobId(id, 'dj-1');

    // A stale notification never enters the active branch's context.
    store.parentSettled();
    store.parentUserMessage();
    expect(store.list()).toHaveLength(1);

    store.jobResultEntered(['dj-1']);
    store.parentSettled();
    expect(store.list()).toHaveLength(1);
    store.parentUserMessage();
    expect(store.list()).toEqual([]);
  });

  test('groups continuations into one lineage until its latest run is acknowledged', () => {
    const store = new DelegateStatusStore();
    const first = createRun('initial', undefined, {
      name: 'Implementation',
      sessionId: 'child-session',
      continuation: 'child-token',
    });
    first.startedAt = 1_000;
    first.finishedAt = 301_000;
    first.state = 'success';
    const [firstId] = store.start([first], 'foreground');
    store.resultEntered([firstId]);
    store.parentSettled();

    const continued = createRun('continue', undefined, {
      name: 'Implementation follow-up',
      sessionId: 'child-session',
      continuation: 'child-token',
      context: 'continuation',
    });
    continued.startedAt = 400_000;
    continued.state = 'running';
    const [continuedId] = store.start([continued], 'foreground');

    expect(store.list()).toMatchObject([
      {
        id: firstId,
        name: 'Implementation follow-up',
        sessionId: 'child-session',
        state: 'running',
        context: 'continuation',
        runCount: 2,
        runs: [
          { state: 'success', startedAt: 1_000, finishedAt: 301_000 },
          { state: 'running', startedAt: 400_000 },
        ],
      },
    ]);

    store.parentUserMessage();
    expect(store.list()).toHaveLength(1);

    continued.state = 'success';
    continued.finishedAt = 580_000;
    store.update(continuedId, continued);
    store.resultEntered([continuedId]);
    store.parentSettled();
    expect(store.list()).toHaveLength(1);
    store.parentUserMessage();
    expect(store.list()).toEqual([]);
  });

  test('publishes logical workflow attempts and metadata-only wake state', () => {
    const store = new DelegateStatusStore();
    const run = createRun('scheduled review');
    const [id] = store.start([run], 'background');
    store.setWorkflow(id, {
      attempt: { logicalId: 'review', ordinal: 1, identity: 'review@1' },
      logicalId: 'review',
      ordinal: 1,
      identity: 'review@1',
      dependencies: ['impl@1'],
      inputs: [
        {
          selector: { node: 'impl', include: ['report', 'branch'] },
          identity: 'impl@1',
        },
      ],
      state: 'scheduled',
      createdAt: 1,
      scheduledAt: 1,
      reason: 'waiting for impl@1',
    } as never);
    store.setWakes([
      {
        id: 'review-ready',
        state: 'pending',
        references: ['review@1'],
        createdAt: 2,
      } as never,
    ]);

    expect(store.list()[0]?.workflow).toMatchObject({
      identity: 'review@1',
      state: 'scheduled',
      dependencies: ['impl@1'],
      inputs: [
        {
          node: 'impl',
          identity: 'impl@1',
          include: ['report', 'branch'],
        },
      ],
      reason: 'waiting for impl@1',
    });
    expect(store.getWakes()).toEqual([
      {
        id: 'review-ready',
        state: 'pending',
        references: ['review@1'],
        waitingFor: ['review@1'],
        createdAt: 2,
      },
    ]);
    expect(JSON.stringify(store.getWakes())).not.toMatch(
      /handoff|report|payload|outputFile|diagnostic|transcript/i,
    );
  });

  test('clears a lineage when only its latest async attempt is delivered', () => {
    const store = new DelegateStatusStore();
    const first = createRun('initial implementation', undefined, {
      lineageId: 'lineage-impl',
    });
    first.state = 'success';
    first.exitCode = 0;
    first.finishedAt = 2;
    const second = createRun('corrected implementation', undefined, {
      lineageId: 'lineage-impl',
    });
    second.state = 'success';
    second.exitCode = 0;
    second.finishedAt = 4;
    const [firstId, secondId] = store.start([first, second], 'background');
    store.setWorkflow(firstId, {
      attempt: { logicalId: 'impl', ordinal: 1, identity: 'impl@1' },
      logicalId: 'impl',
      ordinal: 1,
      identity: 'impl@1',
      dependencies: [],
      waitingFor: [],
      inputs: [],
      state: 'success',
      createdAt: 1,
      scheduledAt: 1,
      settledAt: 2,
    });
    store.setWorkflow(secondId, {
      attempt: { logicalId: 'impl', ordinal: 2, identity: 'impl@2' },
      logicalId: 'impl',
      ordinal: 2,
      identity: 'impl@2',
      dependencies: ['impl@1'],
      waitingFor: [],
      inputs: [],
      state: 'success',
      createdAt: 3,
      scheduledAt: 3,
      settledAt: 4,
    });

    store.markWorkflowDelivered(['impl@2']);
    expect(store.list()[0]?.workflow).toMatchObject({
      identity: 'impl@2',
      deliveredToParent: true,
    });
    store.parentSettled();
    store.parentUserMessage();
    expect(store.list()).toEqual([]);
  });

  test('keeps the last activity that had content while the next one warms up', () => {
    const store = new DelegateStatusStore();
    const run = createRun('audit');
    run.activities.push({
      type: 'tool',
      label: 'read src/index.ts',
      status: 'completed',
    });
    const [id] = store.start([run], 'foreground');
    expect(store.list()[0].activity).toMatchObject({
      label: 'read src/index.ts',
    });

    // Announced before its first token arrives.
    run.activities.push({
      type: 'thinking',
      label: 'thinking',
      status: 'running',
    });
    store.update(id, run);
    expect(store.list()[0].activity).toMatchObject({
      label: 'read src/index.ts',
    });

    const thinking = run.activities.at(-1);
    if (thinking) thinking.latestText = 'Weighing the two layouts';
    store.update(id, run);
    expect(store.list()[0].activity).toMatchObject({
      type: 'thinking',
      latestText: 'Weighing the two layouts',
    });
  });
});
