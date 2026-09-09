import type {
  BackgroundWatchInput,
  BackgroundWatchSnapshot,
} from '@pi-agent/background-jobs';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundJobsTransport, BackgroundSnapshot } from './manager';
import { BackgroundManager } from './manager';

const id = '123e4567-e89b-12d3-a456-426614174099';

function snapshot(
  overrides: Partial<BackgroundSnapshot> = {},
): BackgroundSnapshot {
  return {
    id,
    ownerSession: 'test',
    title: 'server',
    command: 'server',
    cwd: '.',
    status: 'running',
    createdAt: 1,
    completionDelivered: false,
    stdout: { text: '', totalBytes: 0, droppedBytes: 0 },
    stderr: { text: '', totalBytes: 0, droppedBytes: 0 },
    ...overrides,
  };
}

function watch(
  overrides: Partial<BackgroundWatchSnapshot> = {},
): BackgroundWatchSnapshot {
  return {
    id: 'watch-1',
    contains: 'ready',
    status: 'pending',
    createdAt: 2,
    ...overrides,
  };
}

function transport(initial = snapshot()) {
  let current = initial;
  let inspected = current;
  const ackWatches: Array<[string, string[]]> = [];
  const transport: BackgroundJobsTransport & {
    inspectCalls: number;
    ackWatches: Array<[string, string[]]>;
    setCurrent(next: BackgroundSnapshot, detailed?: BackgroundSnapshot): void;
  } = {
    inspectCalls: 0,
    ackWatches,
    setCurrent(next, detailed = next) {
      current = next;
      inspected = detailed;
    },
    async start() {
      return current;
    },
    async list() {
      return [
        {
          ...current,
          stdout: {
            text: '',
            totalBytes: current.stdout.totalBytes,
            droppedBytes: 0,
          },
          stderr: {
            text: '',
            totalBytes: current.stderr.totalBytes,
            droppedBytes: 0,
          },
        },
      ];
    },
    async inspect() {
      transport.inspectCalls++;
      return inspected;
    },
    async stop() {
      return [current];
    },
    async info() {
      return { outputWatches: true };
    },
    async watch(_id: string, inputs: readonly BackgroundWatchInput[]) {
      const watches = inputs.map((input, index) => ({
        ...input,
        id: `watch-${index + 1}`,
        status: 'pending' as const,
        createdAt: Date.now(),
      }));
      current = { ...current, watches };
      inspected = current;
      return current;
    },
    async unwatch(_id: string, watchIds: readonly string[]) {
      current = {
        ...current,
        watches: current.watches?.filter((item) => !watchIds.includes(item.id)),
      };
      inspected = current;
      return current;
    },
    async acknowledgeWatches(jobId, watchIds) {
      ackWatches.push([jobId, [...watchIds]]);
    },
  };
  return transport;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('BackgroundManager watches', () => {
  it('peeks immediately through inspect and never uses wait', async () => {
    const client = transport();
    const manager = new BackgroundManager({ client, scopeId: 'peek' });
    try {
      await expect(manager.peek(id)).resolves.toMatchObject({
        status: 'running',
      });
      expect(client.inspectCalls).toBeGreaterThan(0);
    } finally {
      await manager.dispose();
    }
  });

  it('delivers a terminal watch while its process is still running', async () => {
    const delivered = vi.fn();
    const client = transport(
      snapshot({
        watches: [watch({ status: 'matched', excerpt: 'ready now' })],
      }),
    );
    const manager = new BackgroundManager({
      client,
      onWatchSettled: delivered,
      scopeId: 'match',
    });
    try {
      await manager.list();
      await settle();
      expect(delivered).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'running' }),
        expect.objectContaining({ id: 'watch-1', status: 'matched' }),
      );
    } finally {
      await manager.dispose();
    }
  });

  it('retries a failed watch publication and ACKs only an entered message', async () => {
    const delivered = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const client = transport(
      snapshot({ watches: [watch({ status: 'timed_out' })] }),
    );
    const manager = new BackgroundManager({
      client,
      onWatchSettled: delivered,
      scopeId: 'retry',
    });
    try {
      await manager.list();
      await settle();
      expect(delivered).toHaveBeenCalledTimes(1);
      await manager.list();
      await settle();
      expect(delivered).toHaveBeenCalledTimes(2);
      expect(client.ackWatches).toEqual([]);
      await manager.acknowledgeEntered([
        {
          customType: 'background-watch-result',
          details: { id, watchId: 'watch-1', dedupeKey: `${id}:watch-1` },
        },
      ]);
      expect(client.ackWatches).toEqual([[id, ['watch-1']]]);
    } finally {
      await manager.dispose();
    }
  });

  it('does not publish a watch cancelled during unwatch', async () => {
    const delivered = vi.fn();
    const client = transport(snapshot({ watches: [watch()] }));
    const manager = new BackgroundManager({
      client,
      onWatchSettled: delivered,
      scopeId: 'unwatch',
    });
    try {
      client.setCurrent(snapshot({ watches: [watch({ status: 'matched' })] }));
      const notifying = manager.list();
      const removing = manager.unwatch(id, ['watch-1']);
      await Promise.all([notifying, removing]);
      await settle();
      expect(delivered).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it('cancels watch delivery before a racing stop and ACKs the watches', async () => {
    const delivered = vi.fn();
    const removed = vi.fn();
    const client = transport(snapshot({ watches: [watch()] }));
    const manager = new BackgroundManager({
      client,
      onWatchSettled: delivered,
      onWatchesRemoved: removed,
      scopeId: 'stop',
    });
    try {
      await manager.list();
      client.setCurrent(snapshot({ watches: [watch({ status: 'matched' })] }));
      const notifying = manager.list();
      const stopping = manager.stop([id]);
      await Promise.all([notifying, stopping]);
      await settle();
      expect(delivered).not.toHaveBeenCalled();
      expect(removed).toHaveBeenCalledWith(id, ['watch-1']);
      expect(client.ackWatches).toEqual([[id, ['watch-1']]]);
    } finally {
      await manager.dispose();
    }
  });

  it('coalesces multiple ended watches into completion', async () => {
    const completion = vi.fn().mockReturnValue(true);
    const watchDelivery = vi.fn();
    const client = transport(
      snapshot({
        status: 'done',
        completionDelivered: false,
        watches: [
          watch({ id: 'watch-1', status: 'ended' }),
          watch({ id: 'watch-2', contains: 'finished', status: 'ended' }),
        ],
      }),
    );
    const manager = new BackgroundManager({
      client,
      onSettled: completion,
      onWatchSettled: watchDelivery,
      scopeId: 'coalesce',
    });
    try {
      await manager.list();
      await settle();
      expect(completion).toHaveBeenCalledTimes(1);
      expect(completion.mock.calls[0][0]).toMatchObject({ status: 'done' });
      expect(watchDelivery).not.toHaveBeenCalled();
      await manager.acknowledgeEntered([
        {
          customType: 'background-terminal-result',
          details: {
            id,
            dedupeKey: id,
            status: 'done',
            endedWatches: [
              { id: 'watch-1', contains: 'ready' },
              { id: 'watch-2', contains: 'finished' },
            ],
          },
        },
      ]);
      expect(client.ackWatches).toEqual([[id, ['watch-1', 'watch-2']]]);
    } finally {
      await manager.dispose();
    }
  });

  it('redelivers an unacknowledged watch after manager recreation', async () => {
    const client = transport(
      snapshot({ watches: [watch({ status: 'ended' })] }),
    );
    const first = vi.fn();
    const manager = new BackgroundManager({
      client,
      onWatchSettled: first,
      scopeId: 'recreate',
    });
    await manager.list();
    await settle();
    await manager.dispose();

    const second = vi.fn();
    const recreated = new BackgroundManager({
      client,
      onWatchSettled: second,
      scopeId: 'recreate',
    });
    try {
      await recreated.list();
      await settle();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      await recreated.dispose();
    }
  });

  it('does not launch after disposal during the capability check', async () => {
    const client = transport();
    let resolveInfo!: (value: { outputWatches: boolean }) => void;
    client.info = () =>
      new Promise((resolve) => {
        resolveInfo = resolve;
      });
    const start = vi.spyOn(client, 'start');
    const manager = new BackgroundManager({ client });
    const pending = manager.start({
      command: 'server',
      cwd: '.',
      watch: [{ contains: 'ready' }],
    });
    await settle();
    await manager.dispose();
    resolveInfo({ outputWatches: true });
    await expect(pending).rejects.toThrow('shut down');
    expect(start).not.toHaveBeenCalled();
  });

  it('retries notifications after stop fails', async () => {
    const delivered = vi.fn();
    const client = transport(snapshot({ watches: [watch()] }));
    client.stop = async () => {
      throw new Error('host unavailable');
    };
    const manager = new BackgroundManager({
      client,
      onWatchSettled: delivered,
    });
    try {
      await manager.list();
      await expect(manager.stop([id])).rejects.toThrow('host unavailable');
      client.setCurrent(snapshot({ watches: [watch({ status: 'matched' })] }));
      await manager.list();
      await settle();
      expect(delivered).toHaveBeenCalledTimes(1);
    } finally {
      await manager.dispose();
    }
  });

  it('retries notifications after unwatch refresh fails', async () => {
    const delivered = vi.fn();
    const client = transport(snapshot({ watches: [watch()] }));
    const manager = new BackgroundManager({
      client,
      onWatchSettled: delivered,
    });
    try {
      await manager.list();
      const list = client.list;
      client.list = async () => {
        throw new Error('host unavailable');
      };
      await expect(manager.unwatch(id, ['watch-1'])).rejects.toThrow(
        'host unavailable',
      );
      client.list = list;
      client.setCurrent(snapshot({ watches: [watch({ status: 'matched' })] }));
      await manager.list();
      await settle();
      expect(delivered).toHaveBeenCalledTimes(1);
    } finally {
      await manager.dispose();
    }
  });

  it('fetches inspect evidence before completion publication', async () => {
    const delivered = vi.fn();
    const client = transport(snapshot({ status: 'done', settledAt: 3 }));
    client.setCurrent(
      snapshot({ status: 'done', settledAt: 3 }),
      snapshot({
        status: 'done',
        settledAt: 3,
        stdout: { text: 'finished', totalBytes: 8, droppedBytes: 0 },
      }),
    );
    const manager = new BackgroundManager({
      client,
      onSettled: delivered,
      scopeId: 'evidence',
    });
    try {
      await manager.list();
      await settle();
      expect(delivered).toHaveBeenCalledWith(
        expect.objectContaining({
          stdout: expect.objectContaining({ text: 'finished' }),
        }),
      );
    } finally {
      await manager.dispose();
    }
  });
});
