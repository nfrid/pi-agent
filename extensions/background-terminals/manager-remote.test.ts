import { describe, expect, it, vi } from 'vitest';
import type { BackgroundSnapshot } from './manager';
import { type BackgroundJobsTransport, BackgroundManager } from './manager';

function snapshot(
  overrides: Partial<BackgroundSnapshot> = {},
): BackgroundSnapshot {
  return {
    id: '123e4567-e89b-12d3-a456-426614174099',
    ownerSession: 'scope',
    title: 'job',
    command: 'true',
    cwd: '.',
    status: 'done',
    createdAt: 1,
    settledAt: 2,
    exitCode: 0,
    completionDelivered: false,
    stdout: { text: '', totalBytes: 0, droppedBytes: 0 },
    stderr: { text: '', totalBytes: 0, droppedBytes: 0 },
    ...overrides,
  };
}

function fakeTransport(initial = snapshot()) {
  let current = initial;
  const transport: BackgroundJobsTransport & {
    listCalls: number;
    ackCalls: string[];
  } = {
    listCalls: 0,
    ackCalls: [],
    async start() {
      return current;
    },
    async list() {
      transport.listCalls++;
      return [current];
    },
    async inspect() {
      return current;
    },
    async wait() {
      return current;
    },
    async stop() {
      return [current];
    },
    async markDelivered(id) {
      transport.ackCalls.push(id);
      current = { ...current, completionDelivered: true };
    },
  };
  return transport;
}

describe('BackgroundManager remote lifecycle', () => {
  it('recovers when the process host appears after construction', async () => {
    let available = false;
    const transport = fakeTransport(
      snapshot({ status: 'running', settledAt: undefined }),
    );
    const list = transport.list;
    transport.list = async () => {
      if (!available) throw new Error('socket unavailable');
      return list();
    };
    const manager = new BackgroundManager({
      client: transport,
      scopeId: 'late',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    available = true;
    await expect(manager.list()).resolves.toHaveLength(1);
    await manager.dispose();
  });

  it('fails all operations closed after disposal and ignores late starts', async () => {
    let resolveStart!: (value: BackgroundSnapshot) => void;
    const transport = fakeTransport(
      snapshot({ status: 'running', settledAt: undefined }),
    );
    transport.start = () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      });
    const manager = new BackgroundManager({
      client: transport,
      scopeId: 'dispose',
    });
    await manager.list();
    const pending = manager.start({
      command: 'sleep 1',
      title: 'job',
      cwd: '.',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.dispose();
    resolveStart(snapshot({ status: 'running', settledAt: undefined }));
    await expect(pending).rejects.toThrow(/shut down/);
    const calls = transport.listCalls;
    await expect(manager.list()).rejects.toThrow(/shut down/);
    await expect(manager.inspect('x')).rejects.toThrow(/shut down/);
    await expect(manager.peek('x')).rejects.toThrow(/shut down/);
    await expect(manager.stop(['x'])).rejects.toThrow(/shut down/);
    await manager.acknowledgeEntered([
      {
        customType: 'background-terminal-result',
        details: {
          id: snapshot().id,
          dedupeKey: snapshot().id,
          status: 'done',
        },
      },
    ]);
    expect(transport.listCalls).toBe(calls);
    expect(transport.ackCalls).toEqual([]);
  });

  it('ignores incompatible wait responses that arrive after disposal', async () => {
    let resolveWait!: (value: BackgroundSnapshot) => void;
    const transport = fakeTransport(
      snapshot({ status: 'running', settledAt: undefined }),
    );
    transport.wait = () =>
      new Promise((resolve) => {
        resolveWait = resolve;
      });
    const onChange = vi.fn();
    const manager = new BackgroundManager({
      client: transport,
      scopeId: 'late-wait',
      onChange,
    });
    await manager.list();
    const pending = manager.peek(snapshot().id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.dispose();
    const changeCallsAfterDispose = onChange.mock.calls.length;

    resolveWait(snapshot({ exactEnv: true }));
    await expect(pending).rejects.toThrow(/shut down/);
    expect(onChange).toHaveBeenCalledTimes(changeCallsAfterDispose);
  });

  it.each([
    'peek',
    'stop',
  ] as const)('fails closed when disposal occurs during a %s completion ACK', async (operation) => {
    let resolveAck!: () => void;
    const initial = snapshot({
      status: operation === 'stop' ? 'running' : 'done',
      ...(operation === 'stop' ? { settledAt: undefined } : {}),
    });
    const transport = fakeTransport(initial);
    if (operation === 'stop')
      transport.stop = async () => [snapshot({ status: 'done' })];
    transport.markDelivered = () =>
      new Promise<void>((resolve) => {
        resolveAck = resolve;
      });
    const onChange = vi.fn();
    const manager = new BackgroundManager({
      client: transport,
      scopeId: `late-${operation}-ack`,
      onChange,
    });
    await manager.list();
    const pending =
      operation === 'peek'
        ? manager.peek(initial.id)
        : manager.stop([initial.id]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.dispose();
    const changeCallsAfterDispose = onChange.mock.calls.length;

    resolveAck();
    await expect(pending).rejects.toThrow(/shut down/);
    expect(onChange).toHaveBeenCalledTimes(changeCallsAfterDispose);
  });

  it('does not adopt or control exact-environment delegate jobs', async () => {
    const delegate = snapshot({ exactEnv: true });
    const transport = fakeTransport(delegate);
    const onSettled = vi.fn();
    const inspect = vi.spyOn(transport, 'inspect');
    const wait = vi.spyOn(transport, 'wait');
    const stop = vi.spyOn(transport, 'stop');
    const manager = new BackgroundManager({
      client: transport,
      scopeId: 'shared-owner',
      onSettled,
    });

    await expect(manager.list()).resolves.toEqual([]);
    await expect(manager.inspect(delegate.id)).resolves.toBeUndefined();
    await expect(manager.peek(delegate.id)).rejects.toThrow(
      /Unknown background process/,
    );
    await expect(manager.stop([delegate.id])).resolves.toEqual([]);
    await manager.acknowledgeEntered([
      {
        customType: 'background-terminal-result',
        details: {
          id: delegate.id,
          dedupeKey: delegate.id,
          status: 'done',
        },
      },
    ]);

    expect(onSettled).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(transport.ackCalls).toEqual([]);
    await manager.dispose();
  });

  it('fails closed when a stop response changes to exact environment', async () => {
    const shell = snapshot({ status: 'running', settledAt: undefined });
    const transport = fakeTransport(shell);
    transport.stop = vi.fn(async () => [snapshot({ exactEnv: true })]);
    const manager = new BackgroundManager({
      client: transport,
      scopeId: 'raced-owner',
    });

    await expect(manager.list()).resolves.toHaveLength(1);
    await expect(manager.stop([shell.id])).resolves.toEqual([]);
    expect(manager.get(shell.id)).toBeUndefined();
    expect(manager.runningCount).toBe(0);
    expect(transport.ackCalls).toEqual([]);
    await manager.dispose();
  });

  it('ACKs only trusted entered completion messages', async () => {
    const done = snapshot();
    const transport = fakeTransport(done);
    const manager = new BackgroundManager({
      client: transport,
      scopeId: 'trusted',
    });
    await manager.list();
    await manager.acknowledgeEntered([
      {
        customType: 'other',
        details: { id: done.id, dedupeKey: done.id, status: 'done' },
      },
      {
        customType: 'background-terminal-result',
        details: { id: done.id, status: 'done' },
      },
      {
        customType: 'background-terminal-result',
        details: { id: done.id, dedupeKey: 'other', status: 'done' },
      },
      {
        customType: 'background-terminal-result',
        details: { id: done.id, dedupeKey: done.id, status: 'running' },
      },
      {
        customType: 'background-terminal-result',
        details: { id: 'arbitrary', dedupeKey: 'arbitrary', status: 'done' },
      },
      {
        customType: 'background-terminal-result',
        details: { id: done.id, dedupeKey: done.id, status: 'done' },
      },
    ]);
    expect(transport.ackCalls).toEqual([done.id]);
    await manager.dispose();
  });

  it('redelivers queued completions until context entry ACKs them', async () => {
    const transport = fakeTransport();
    const firstDelivery = vi.fn();
    const first = new BackgroundManager({
      client: transport,
      scopeId: 'resume',
      onSettled: firstDelivery,
    });
    await first.list();
    expect(firstDelivery).toHaveBeenCalledTimes(1);
    await first.dispose();

    const secondDelivery = vi.fn();
    const second = new BackgroundManager({
      client: transport,
      scopeId: 'resume',
      onSettled: secondDelivery,
    });
    await second.list();
    expect(secondDelivery).toHaveBeenCalledTimes(1);
    await second.acknowledgeEntered([
      {
        customType: 'background-terminal-result',
        details: {
          id: snapshot().id,
          dedupeKey: snapshot().id,
          status: 'done',
        },
      },
    ]);
    await second.dispose();

    const thirdDelivery = vi.fn();
    const third = new BackgroundManager({
      client: transport,
      scopeId: 'resume',
      onSettled: thirdDelivery,
    });
    await third.list();
    expect(thirdDelivery).not.toHaveBeenCalled();
    await third.dispose();
  });
});
