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
