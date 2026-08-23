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
