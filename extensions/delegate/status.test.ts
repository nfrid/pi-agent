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
    };
    Object.defineProperty(activity, 'latestText', {
      value: 'Checking the changed execution paths',
      enumerable: false,
    });
    run.activities.push(activity);
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
    });

    store.finish([id]);
    expect(store.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  test('acknowledges a settled result only after a later parent turn responds and settles', () => {
    const store = new DelegateStatusStore();
    const run = createRun('audit');
    const [id] = store.start([run], 'foreground');

    store.resultEntered([id]);
    expect(store.list()).toHaveLength(1);

    run.state = 'success';
    store.update(id, run);
    store.resultEntered([id]);
    store.acknowledgeSettled();
    expect(store.list()).toHaveLength(1);

    // An assistant message from the turn that was already in progress did
    // not receive this result in provider context.
    store.parentAssistantMessage();
    store.acknowledgeSettled();
    expect(store.list()).toHaveLength(1);

    store.parentTurnStarted();
    store.parentAssistantMessage();
    store.acknowledgeSettled();
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
    store.parentAssistantMessage();
    store.acknowledgeSettled();
    expect(store.list()).toHaveLength(1);

    store.jobResultEntered(['dj-1']);
    store.parentTurnStarted();
    store.parentAssistantMessage();
    store.acknowledgeSettled();
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
