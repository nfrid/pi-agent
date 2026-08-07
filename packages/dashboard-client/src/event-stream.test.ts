import { describe, expect, it, vi } from 'vitest';
import {
  consumeSseResponse,
  DashboardEventStream,
  RECONNECT_MIN_MS,
  yieldToBrowser,
} from './event-stream.js';
import type { DashboardHttpClient } from './http-client.js';
import { DashboardHttpError, ReplayGapError } from './http-client.js';

const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('DashboardEventStream lifecycle', () => {
  it('falls back when animation frames are suspended in a hidden tab', async () => {
    let canceledFrame: number | undefined;
    vi.stubGlobal('requestAnimationFrame', () => 42);
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => {
      canceledFrame = frame;
    });
    try {
      await yieldToBrowser(0);
      expect(canceledFrame).toBe(42);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('yields between bounded record batches without falling behind token streams', async () => {
    const encoder = new TextEncoder();
    const frame = (cursor: number) =>
      `data: ${JSON.stringify({
        cursor,
        emittedAt: cursor,
        event: { type: 'agent.settled', sessionId: 'session-1' },
      })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // One transport read can contain many proxy-buffered SSE frames.
        controller.enqueue(
          encoder.encode(
            Array.from({ length: 33 }, (_, index) => frame(index + 1)).join(''),
          ),
        );
        controller.close();
      },
    });
    const records: number[] = [];
    let releaseFirstYield: (() => void) | undefined;
    let yieldCount = 0;
    const consuming = consumeSseResponse(
      new Response(body),
      (record) => {
        records.push(record.cursor);
      },
      undefined,
      undefined,
      () => {
        yieldCount += 1;
        return new Promise<void>((resolve) => {
          releaseFirstYield = resolve;
        });
      },
    );

    await expect.poll(() => records).toHaveLength(32);
    expect(yieldCount).toBe(1);
    releaseFirstYield?.();
    await expect(consuming).resolves.toBe(33);
    expect(records).toHaveLength(33);
  });

  it('marks an idle response connected before the first data record', async () => {
    const states: string[] = [];
    const client = {
      events: async () =>
        new Response(
          new ReadableStream<Uint8Array>({ start: () => undefined }),
        ),
    } as unknown as DashboardHttpClient;
    const stream = new DashboardEventStream({
      client,
      getCursor: () => 0,
      getServerId: () => undefined,
      onRecord: () => undefined,
      onReplayGap: async () => undefined,
      onState: (state) => states.push(state),
      onError: () => undefined,
      isOnline: () => true,
    });
    stream.start();
    await wait();
    expect(states).toEqual(['connecting', 'connected']);
    stream.stop();
  });

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

  it('aborts a suspended connection and rejects its buffered records before reconnecting', async () => {
    let calls = 0;
    let aborts = 0;
    const encoder = new TextEncoder();
    const frame = (cursor: number) =>
      `data: ${JSON.stringify({
        cursor,
        emittedAt: cursor,
        event: { type: 'agent.settled', sessionId: 'session-1' },
      })}\n\n`;
    const client = {
      events: async (_cursor: number, signal: AbortSignal) => {
        calls += 1;
        signal.addEventListener('abort', () => {
          aborts += 1;
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (calls === 1)
                controller.enqueue(encoder.encode(frame(1) + frame(2)));
            },
          }),
        );
      },
    } as unknown as DashboardHttpClient;
    const records: number[] = [];
    let stream!: DashboardEventStream;
    stream = new DashboardEventStream({
      client,
      getCursor: () => records.at(-1) ?? 0,
      getServerId: () => undefined,
      onRecord: (record) => {
        records.push(record.cursor);
        if (record.cursor === 1) stream.reconnect();
      },
      onReplayGap: async () => undefined,
      onState: () => undefined,
      onError: () => undefined,
      isOnline: () => true,
    });
    stream.start();
    await expect.poll(() => calls).toBe(2);
    expect(records).toEqual([1]);
    expect(aborts).toBe(1);
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

  it('keeps exponential backoff when replay-gap resync fails', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        events: async () => {
          calls += 1;
          throw new ReplayGapError();
        },
      } as unknown as DashboardHttpClient;
      const stream = new DashboardEventStream({
        client,
        getCursor: () => 4,
        getServerId: () => 'daemon-a',
        onRecord: () => undefined,
        onReplayGap: async () => {
          throw new Error('snapshot failed');
        },
        onState: () => undefined,
        onError: () => undefined,
        isOnline: () => true,
        random: () => 0.5,
      });
      stream.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS - 1);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2 - 1);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(3);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
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
