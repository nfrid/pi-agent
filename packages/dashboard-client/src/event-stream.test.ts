import { describe, expect, it } from 'vitest';
import { DashboardEventStream } from './event-stream.js';
import type { DashboardHttpClient } from './http-client.js';
import { DashboardHttpError, ReplayGapError } from './http-client.js';

const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('DashboardEventStream lifecycle', () => {
  it('stops on authentication failure instead of retrying', async () => {
    let calls = 0;
    let error: Error | undefined;
    const client = {
      events: async () => {
        calls += 1;
        throw new DashboardHttpError(401, 'Authentication required.');
      },
    } as unknown as DashboardHttpClient;
    const stream = new DashboardEventStream({
      client,
      getCursor: () => 0,
      getServerId: () => undefined,
      onRecord: () => undefined,
      onReplayGap: async () => undefined,
      onState: () => undefined,
      onError: (next) => {
        error = next;
      },
      isOnline: () => true,
    });
    stream.start();
    await wait();
    await wait();
    expect(calls).toBe(1);
    expect(error?.message).toContain('Authentication');
    stream.stop();
  });

  it('keeps one active connection when a lifecycle is restarted', async () => {
    let active = 0;
    let maximum = 0;
    const client = {
      events: async (_cursor: number, signal: AbortSignal) => {
        active += 1;
        maximum = Math.max(maximum, active);
        signal.addEventListener('abort', () => {
          active -= 1;
        });
        return new Response(
          new ReadableStream<Uint8Array>({ start: () => undefined }),
        );
      },
    } as unknown as DashboardHttpClient;
    const stream = new DashboardEventStream({
      client,
      getCursor: () => 0,
      getServerId: () => undefined,
      onRecord: () => undefined,
      onReplayGap: async () => undefined,
      onState: () => undefined,
      onError: () => undefined,
      isOnline: () => true,
    });
    const firstStop = stream.start();
    await wait();
    firstStop();
    const secondStop = stream.start();
    await wait();
    expect(maximum).toBe(1);
    secondStop();
  });

  it('supplies the daemon generation and treats a collision as a replay gap', async () => {
    let replayGaps = 0;
    const client = {
      events: async (
        cursor: number,
        _signal: AbortSignal,
        serverId?: string,
      ) => {
        expect(cursor).toBe(4);
        expect(serverId).toBe('daemon-a');
        throw new ReplayGapError();
      },
    } as unknown as DashboardHttpClient;
    const stream = new DashboardEventStream({
      client,
      getCursor: () => 4,
      getServerId: () => 'daemon-a',
      onRecord: () => undefined,
      onReplayGap: async () => {
        replayGaps += 1;
      },
      onState: () => undefined,
      onError: () => undefined,
      isOnline: () => true,
    });
    stream.start();
    await wait();
    expect(replayGaps).toBe(1);
    stream.stop();
  });
});
