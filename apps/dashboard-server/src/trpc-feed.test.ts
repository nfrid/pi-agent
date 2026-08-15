import { createTRPCClient, httpSubscriptionLink } from '@trpc/client';
import { EventSource } from 'eventsource';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ShellFeed } from './live-feeds.js';
import {
  createDashboardRouter,
  type DashboardRouter,
  type DashboardTrpcContext,
  registerDashboardTrpc,
} from './trpc.js';

function shellSnapshot(sequence: number) {
  return {
    serverId: 'server-generation',
    revision: sequence,
    cursor: sequence,
    runtimes: [],
    workspaces: [],
    sessions: [],
    unread: [],
  };
}

describe('production tRPC feed procedures', () => {
  it('httpSubscriptionLink reconnects with tracked input and auth headers', async () => {
    const app = Fastify();
    const feed = new ShellFeed({ generation: 'generation' });
    const context: DashboardTrpcContext = {
      serverId: () => 'server-generation',
      snapshot: () => shellSnapshot(feed.sequence),
      shellSnapshot: () => ({
        snapshot: shellSnapshot(feed.sequence),
        cursor: feed.sequence,
      }),
      shellFeed: feed,
      shellSnapshotAt: (sequence) => ({
        snapshot: shellSnapshot(sequence),
        cursor: sequence,
      }),
    };
    app.addHook('onRequest', async (request, reply) => {
      if (request.headers['x-dashboard-token'] !== 'test-token')
        return reply.code(401).send();
    });
    registerDashboardTrpc(app, context);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No port.');
    const initialCursor = feed.currentId;
    const requests: { url: string; token: string | undefined }[] = [];
    let cutFirstConnection = true;
    const values: unknown[] = [];
    let resolveValues!: () => void;
    let rejectValues!: (error: Error) => void;
    const receivedMissed = new Promise<void>((resolve, reject) => {
      resolveValues = resolve;
      rejectValues = reject;
    });
    const client = createTRPCClient<DashboardRouter>({
      links: [
        httpSubscriptionLink({
          url: `http://127.0.0.1:${address.port}/trpc`,
          EventSource,
          eventSourceOptions: {
            fetch: async (input, init) => {
              const headers = new Headers(init?.headers);
              headers.set('x-dashboard-token', 'test-token');
              requests.push({
                url: String(input),
                token: headers.get('x-dashboard-token') ?? undefined,
              });
              const response = await fetch(input, { ...init, headers });
              if (!cutFirstConnection || !response.body) return response;
              cutFirstConnection = false;
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              const encoder = new TextEncoder();
              let pendingText = '';
              let cut = false;
              let releaseStall!: () => void;
              const stalled = new Promise<void>((resolve) => {
                releaseStall = resolve;
              });
              const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                  if (cut) return stalled;
                  const chunk = await reader.read();
                  if (chunk.done) {
                    controller.close();
                    return;
                  }
                  const text = decoder.decode(chunk.value, { stream: true });
                  pendingText += text;
                  controller.enqueue(
                    encoder.encode(
                      text.replace(
                        '"reconnectAfterInactivityMs":300000',
                        '"reconnectAfterInactivityMs":50',
                      ),
                    ),
                  );
                  if (
                    /^id:|\nid:/m.test(pendingText) &&
                    /\r?\n\r?\n/.test(pendingText)
                  ) {
                    cut = true;
                    feed.publishSemantic('usage', 1, { usage: { value: 1 } });
                    feed.publishSemantic('usage', 2, { usage: { value: 2 } });
                    void reader.cancel();
                  }
                },
                cancel: () => {
                  releaseStall();
                  return reader.cancel();
                },
              });
              return new Response(body, {
                status: response.status,
                headers: response.headers,
              });
            },
          },
        }),
      ],
    });
    type ShellInput = Parameters<typeof client.shellSubscribe.subscribe>[0];
    type RejectUnknownInput = { cursor: number } extends ShellInput
      ? never
      : true;
    const strictFeedInputCheck: RejectUnknownInput = true;
    void strictFeedInputCheck;
    const subscription = client.shellSubscribe.subscribe(
      {},
      {
        onData(value) {
          values.push(value);
          if (
            values.some((item) => {
              if (!item || typeof item !== 'object') return false;
              const payload =
                'id' in item && 'data' in item
                  ? (item as { data: unknown }).data
                  : item;
              return (
                payload &&
                typeof payload === 'object' &&
                'data' in payload &&
                (payload as { data?: { usage?: { value?: number } } }).data
                  ?.usage?.value === 2
              );
            })
          )
            resolveValues();
        },
        onError: rejectValues,
      },
    );
    try {
      await Promise.race([
        receivedMissed,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `subscription did not resume: ${JSON.stringify({ requests, values })}`,
                ),
              ),
            10_000,
          ),
        ),
      ]);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests.every((request) => request.token === 'test-token')).toBe(
        true,
      );
      const reconnectInput = JSON.parse(
        new URL(requests[1]?.url ?? '').searchParams.get('input') ?? '{}',
      ) as { lastEventId?: string; json?: { lastEventId?: string } };
      expect(
        reconnectInput.lastEventId ?? reconnectInput.json?.lastEventId,
      ).toBe(initialCursor);
      const payloads = values.map((item) =>
        item && typeof item === 'object' && 'id' in item && 'data' in item
          ? (item as { data: unknown }).data
          : item,
      );
      expect(payloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'snapshot' }),
          expect.objectContaining({
            type: 'shell-event',
            sequence: 1,
            data: { usage: { value: 1 } },
          }),
          expect.objectContaining({
            type: 'shell-event',
            sequence: 2,
            data: { usage: { value: 2 } },
          }),
        ]),
      );
    } finally {
      subscription.unsubscribe();
      await app.close();
    }
  }, 15_000);

  it('prefers the transport resume cursor over an initial input cursor', async () => {
    const feed = new ShellFeed({ generation: 'generation' });
    const raw = feed.subscribe({
      buildSnapshot: async (sequence) => ({
        snapshot: shellSnapshot(sequence),
        cursor: sequence,
      }),
    });
    await raw.next();
    await raw.next();
    feed.publishSemantic('usage', 1, { usage: { value: 1 } });
    const first = await raw.next();
    feed.publishSemantic('usage', 2, { usage: { value: 2 } });
    const second = await raw.next();
    await raw.return(undefined);

    const context: DashboardTrpcContext = {
      serverId: () => 'server-generation',
      snapshot: () => shellSnapshot(feed.sequence),
      shellSnapshot: () => ({
        snapshot: shellSnapshot(feed.sequence),
        cursor: feed.sequence,
      }),
      shellFeed: feed,
      shellSnapshotAt: (sequence) => ({
        snapshot: shellSnapshot(sequence),
        cursor: sequence,
      }),
      lastEventId: second.value?.id,
    };
    const caller = createDashboardRouter(context).createCaller(
      context,
    ) as unknown as {
      shellSubscribe(input: {
        lastEventId: string;
      }): Promise<AsyncGenerator<unknown>>;
    };
    const stream = await caller.shellSubscribe({
      lastEventId: first.value?.id ?? '',
    });
    const resumed = (await stream.next()).value as unknown[];
    expect(resumed[1]).toMatchObject({ type: 'caught-up', sequence: 2 });
    await stream.return(undefined);
  });

  it('reconnects with a snapshot after a paused shell subscriber overflows', async () => {
    const feed = new ShellFeed({
      generation: 'generation',
      subscriberQueueCount: 3,
    });
    const context: DashboardTrpcContext = {
      serverId: () => 'server-generation',
      snapshot: () => shellSnapshot(feed.sequence),
      shellSnapshot: () => ({
        snapshot: shellSnapshot(feed.sequence),
        cursor: feed.sequence,
      }),
      shellFeed: feed,
      shellSnapshotAt: (sequence) => ({
        snapshot: shellSnapshot(sequence),
        cursor: sequence,
      }),
    };
    const caller = createDashboardRouter(context).createCaller(
      context,
    ) as unknown as {
      shellSubscribe(
        input: Record<string, unknown>,
      ): Promise<AsyncGenerator<unknown>>;
    };
    const stream = await caller.shellSubscribe({});
    await stream.next();
    const caughtUp = (await stream.next()).value as unknown[];
    const lastId = caughtUp[0] as string;
    for (let value = 1; value <= 4; value += 1)
      feed.publishSemantic('usage', value, { usage: { value } });
    await expect(stream.next()).rejects.toBeInstanceOf(Error);
    expect(feed.metrics().subscribers).toBe(0);

    const resumed = await caller.shellSubscribe({ lastEventId: lastId });
    const rebased = (await resumed.next()).value as unknown[];
    expect(rebased[1]).toMatchObject({ type: 'snapshot' });
    await resumed.return(undefined);
  });

  it('rebases an existing shell subscriber after an oversized semantic update', async () => {
    const feed = new ShellFeed({
      generation: 'generation',
      maxFrameBytes: 1_024,
    });
    const context: DashboardTrpcContext = {
      serverId: () => 'server-generation',
      snapshot: () => shellSnapshot(feed.sequence),
      shellSnapshot: () => ({
        snapshot: shellSnapshot(feed.sequence),
        cursor: feed.sequence,
      }),
      shellFeed: feed,
      shellSnapshotAt: (sequence) => ({
        snapshot: shellSnapshot(sequence),
        cursor: sequence,
      }),
    };
    const caller = createDashboardRouter(context).createCaller(
      context,
    ) as unknown as {
      shellSubscribe(
        input: Record<string, unknown>,
      ): Promise<AsyncGenerator<unknown>>;
    };
    const stream = await caller.shellSubscribe({});
    const initial = await stream.next();
    const lastId = (initial.value as unknown[])[0] as string;
    await stream.next();
    const waiting = stream.next();
    expect(() =>
      feed.publishSemantic('usage', 1, {
        usage: 'x'.repeat(2_000),
      }),
    ).toThrow();
    await expect(waiting).rejects.toBeInstanceOf(Error);

    const resumed = await caller.shellSubscribe({ lastEventId: lastId });
    const resumedValue = (await resumed.next()).value as unknown[];
    expect(resumedValue[0]).toEqual(expect.any(String));
    expect(resumedValue[1]).toEqual(
      expect.objectContaining({ type: 'snapshot' }),
    );
    await resumed.return(undefined);

    const settled = await caller.shellSubscribe({
      lastEventId: resumedValue[0],
    });
    const settledValue = (await settled.next()).value as unknown[];
    expect(settledValue[1]).toMatchObject({ type: 'caught-up' });
    await settled.return(undefined);
  });

  it('yields tracked shell snapshot, caught-up, and live records', async () => {
    const feed = new ShellFeed({ generation: 'generation' });
    const context: DashboardTrpcContext = {
      serverId: () => 'server-generation',
      snapshot: () => shellSnapshot(feed.sequence),
      shellSnapshot: () => ({
        snapshot: shellSnapshot(feed.sequence),
        cursor: feed.sequence,
      }),
      shellFeed: feed,
      shellSnapshotAt: (sequence) => ({
        snapshot: shellSnapshot(sequence),
        cursor: sequence,
      }),
    };
    const caller = createDashboardRouter(context).createCaller(
      context,
    ) as unknown as {
      shellSubscribe(
        input: Record<string, never>,
      ): Promise<AsyncGenerator<unknown>>;
    };
    const stream = await caller.shellSubscribe({});
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect((first.value as unknown[])[0]).toEqual(expect.any(String));
    expect((first.value as unknown[])[1]).toMatchObject({ type: 'snapshot' });
    const caughtUp = await stream.next();
    expect((caughtUp.value as unknown[])[1]).toMatchObject({
      type: 'caught-up',
    });
    feed.publishSemantic('usage', 1, { usage: { refresh: true } });
    const live = await stream.next();
    expect((live.value as unknown[])[1]).toMatchObject({
      type: 'shell-event',
      sequence: 1,
    });
    await stream.return(undefined);
    expect(feed.metrics().subscribers).toBe(0);
  });
});
