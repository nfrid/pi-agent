import { describe, expect, test, vi } from 'vitest';
import { AsyncJobRegistry, type JobRecord } from './registry';

type State = 'running' | 'done' | 'failed';

interface TestRecord extends JobRecord<State> {
  label: string;
}

interface TestSnapshot {
  id: string;
  state: State;
  label: string;
  settledAt?: number;
}

function build(
  options: {
    maxActive?: number;
    maxSettled?: number;
    onSettled?: (snapshot: TestSnapshot) => void;
    onChange?: () => void;
  } = {},
) {
  const registry = new AsyncJobRegistry<State, TestRecord, TestSnapshot>({
    idPrefix: 'tj',
    label: 'test job',
    maxActive: options.maxActive ?? 2,
    maxSettled: options.maxSettled ?? 2,
    isActive: (state) => state === 'running',
    snapshot: (record) => ({
      id: record.id,
      state: record.state,
      label: record.label,
      settledAt: record.settledAt,
    }),
    capacityError: 'too many test jobs',
    disposedError: 'test registry is shutting down',
    teardown: async (record): Promise<void> => {
      registry.settle(record, 'failed');
    },
    onSettled: options.onSettled,
    onChange: options.onChange,
  });
  const add = (label: string) => {
    const record: TestRecord = { ...registry.newRecord('running'), label };
    registry.add(record);
    return record;
  };
  return { registry, add };
}

describe('minting and looking up jobs', () => {
  test('numbers ids from the configured prefix', () => {
    const { registry, add } = build();
    expect(add('first').id).toBe('tj-1');
    expect(add('second').id).toBe('tj-2');
    expect(registry.list().map((job) => job.label)).toEqual([
      'first',
      'second',
    ]);
  });

  test('names the unknown id and what does exist', () => {
    const { registry, add } = build();
    add('first');
    expect(() => registry.require('tj-9')).toThrow(
      'Unknown test job "tj-9". Known: tj-1.',
    );
    expect(registry.get('tj-9')).toBeUndefined();
  });
});

describe('capacity', () => {
  test('counts only active jobs against the limit', () => {
    const { registry, add } = build({ maxActive: 2 });
    const first = add('first');
    add('second');
    expect(() => registry.assertAccepting()).toThrow('too many test jobs');

    registry.settle(first, 'done');
    expect(() => registry.assertAccepting()).not.toThrow();
    // A batch is admitted or rejected as a whole.
    expect(() => registry.assertAccepting(2)).toThrow('too many test jobs');
  });

  test('refuses new work once disposed', async () => {
    const { registry } = build();
    await registry.dispose();
    expect(() => registry.assertAccepting()).toThrow('shutting down');
  });
});

describe('settling', () => {
  test('announces the outcome once and only once', () => {
    const onSettled = vi.fn();
    const { registry, add } = build({ onSettled });
    const record = add('first');

    const snapshot = registry.settle(record, 'done');
    expect(snapshot.state).toBe('done');
    expect(snapshot.settledAt).toBeGreaterThan(0);
    expect(onSettled).toHaveBeenCalledTimes(1);

    // A second settle cannot rewrite an outcome someone was already told about.
    expect(registry.settle(record, 'failed').state).toBe('done');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  test('stays quiet when someone is already waiting for the result', async () => {
    const onSettled = vi.fn();
    const { registry, add } = build({ onSettled });
    const record = add('first');

    const peeked = registry.peek(record.id, 1_000);
    await Promise.resolve();
    registry.settle(record, 'done');
    expect((await peeked).state).toBe('done');
    expect(onSettled).not.toHaveBeenCalled();
  });

  test('reports change on every transition', () => {
    const onChange = vi.fn();
    const { registry, add } = build({ onChange });
    registry.settle(add('first'), 'done');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('peeking', () => {
  test('returns immediately for a settled job', async () => {
    const { registry, add } = build();
    const record = add('first');
    registry.settle(record, 'failed');
    expect((await registry.peek(record.id, 60_000)).state).toBe('failed');
  });

  test('returns the still-running job when the wait runs out', async () => {
    const { registry, add } = build();
    const record = add('first');
    expect((await registry.peek(record.id, 1)).state).toBe('running');
    expect(record.observers).toBe(0);
  });
});

describe('retention', () => {
  test('drops the oldest settled jobs and keeps the active ones', () => {
    const { registry, add } = build({ maxActive: 10, maxSettled: 2 });
    const settled = ['a', 'b', 'c'].map(add);
    const running = add('still going');
    for (const record of settled) registry.settle(record, 'done');

    expect(registry.list().map((job) => job.label)).toEqual([
      'b',
      'c',
      'still going',
    ]);
    expect(registry.get(running.id)?.state).toBe('running');
  });
});

describe('disposal', () => {
  test('tears down active jobs and forgets everything', async () => {
    const onSettled = vi.fn();
    const { registry, add } = build({ onSettled });
    const record = add('first');

    expect(await registry.dispose()).toHaveLength(1);
    expect(record.state).toBe('failed');
    // Shutdown is not news the caller asked for.
    expect(onSettled).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    expect(await registry.dispose()).toEqual([]);
  });
});
