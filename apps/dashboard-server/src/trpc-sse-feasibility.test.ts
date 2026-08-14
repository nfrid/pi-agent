import { Writable } from 'node:stream';
import {
  type BrowserSnapshotSchema,
  DashboardSnapshotResponseSchema,
  DashboardStreamMessageSchema,
  parseDashboardStreamMessage,
  parseSchema,
  SessionRenameRequestSchema,
} from '@pi-dashboard/protocol';
import {
  createTRPCClient,
  getUntypedClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client';
import { initTRPC, tracked } from '@trpc/server';
import { fastifyRequestHandler } from '@trpc/server/adapters/fastify';
import type { EventSourceFetchInit, EventSourceInit } from 'eventsource';
import { EventSource as FetchEventSource } from 'eventsource';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Static, Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedOrigin, authorizeRequest } from './security.js';

const TOKEN = 'phase-0-header-only-secret-9f2d';
const FRAME_LIMIT = 2 * 1024 * 1024;
const DEV_ORIGIN = 'http://dashboard.test';
const MAX_QUEUE_COUNT = 8;
const MAX_QUEUE_BYTES = 4096;
const MAX_REPLAY_BYTES = 16 * 1024;

type FeedName = 'shell' | 'session' | 'resume' | 'generation';
type StreamMessage = Static<typeof DashboardStreamMessageSchema>;
type FeedRecord = {
  id: string;
  data: StreamMessage;
  seq: number;
  key?: string;
  bytes: number;
};
type Cursor = { generation: string; feed: FeedName; seq: number };

type Subscriber = {
  queue: FeedRecord[];
  bytes: number;
  resolve?: (record: FeedRecord) => void;
  reject?: (error: Error) => void;
  closed: boolean;
  error?: Error;
};

function opaqueId(generation: string, feed: FeedName, seq: number): string {
  return Buffer.from(`${generation}|${feed}|${seq}`).toString('base64url');
}

function decodeId(id: string): Cursor | undefined {
  try {
    const [generation, feed, seq] = Buffer.from(id, 'base64url')
      .toString('utf8')
      .split('|');
    if (!generation || !feed || !/^\d+$/.test(seq ?? '')) return undefined;
    if (!['shell', 'session', 'resume', 'generation'].includes(feed))
      return undefined;
    return { generation, feed: feed as FeedName, seq: Number(seq) };
  } catch {
    return undefined;
  }
}

function sessionEntry(feed: FeedName, seq: number) {
  return {
    id: `${feed}-item`,
    file: `/tmp/${feed}.jsonl`,
    cwd: '/tmp',
    name: `${feed}-${seq}`,
    updatedAt: seq,
    entryCount: seq,
  };
}

function snapshot(
  generation: string,
  feed: FeedName,
  seq: number,
  usage?: unknown,
): Static<typeof BrowserSnapshotSchema> {
  return {
    serverId: generation,
    revision: seq,
    cursor: seq,
    runtimes: [],
    workspaces: [],
    sessions: feed === 'session' ? [sessionEntry(feed, seq)] : [],
    unread: [],
    ...(usage === undefined ? {} : { usage }),
  };
}

function snapshotRecord(
  generation: string,
  feed: FeedName,
  seq: number,
): StreamMessage {
  return {
    type: 'snapshot',
    cursor: seq,
    emittedAt: 1_700_000_000_000 + seq,
    snapshot: snapshot(generation, feed, seq),
  };
}

function eventRecord(feed: FeedName, seq: number): StreamMessage {
  return {
    type: 'sessions',
    cursor: seq,
    emittedAt: 1_700_000_000_000 + seq,
    upsert: [sessionEntry(feed, seq)],
    remove: [],
  };
}

class Feed {
  generation = 'g1';
  sequence = 0;
  readonly records: FeedRecord[] = [];
  replayBytes = 0;
  readonly subscribers = new Set<Subscriber>();
  coalesced = 0;
  overflowTerminations = 0;
  readonly maxQueueCount = MAX_QUEUE_COUNT;
  readonly maxQueueBytes = MAX_QUEUE_BYTES;
  onLastListener?: () => void;

  constructor(readonly name: FeedName) {}

  get metrics() {
    return {
      listeners: this.subscribers.size,
      queuedCount: [...this.subscribers].reduce(
        (n, sub) => n + sub.queue.length,
        0,
      ),
      queuedBytes: [...this.subscribers].reduce((n, sub) => n + sub.bytes, 0),
      replayCount: this.records.length,
      replayBytes: this.replayBytes,
      coalesced: this.coalesced,
      overflowTerminations: this.overflowTerminations,
    };
  }

  private record(data: StreamMessage, seq: number, key?: string): FeedRecord {
    parseDashboardStreamMessage(
      parseSchema(DashboardStreamMessageSchema, data, 'stream output'),
    );
    const parsed = data;
    const id = opaqueId(this.generation, this.name, seq);
    // This is the exact frame emitted by tRPC's tracked SSE producer.
    const bytes = Buffer.byteLength(
      `data: ${JSON.stringify(parsed)}\nid: ${id}\n\n`,
    );
    if (bytes > FRAME_LIMIT)
      throw new Error(`SSE frame exceeds ${FRAME_LIMIT} bytes.`);
    return { id, data: parsed, seq, key, bytes };
  }

  private seed(after?: string): FeedRecord[] {
    const cursor = after ? decodeId(after) : undefined;
    const resumable =
      cursor?.generation === this.generation &&
      cursor.feed === this.name &&
      (cursor.seq === 0 ||
        this.records.some((record) => record.seq === cursor.seq));
    if (resumable)
      return this.records.filter((record) => record.seq > cursor.seq);
    // A new generation or an expired cursor starts with one authoritative snapshot.
    return [
      this.record(
        snapshotRecord(this.generation, this.name, this.sequence),
        this.sequence,
      ),
    ];
  }

  async *subscribe(after: string | undefined, signal?: AbortSignal) {
    const queue = this.seed(after);
    const sub: Subscriber = {
      queue,
      bytes: queue.reduce((n, record) => n + record.bytes, 0),
      closed: false,
    };
    this.subscribers.add(sub);
    if (
      sub.queue.length > this.maxQueueCount ||
      sub.bytes > this.maxQueueBytes
    ) {
      this.overflowTerminations += 1;
      this.closeSubscriber(
        sub,
        new Error('Subscriber seed exceeded its count/byte bound.'),
      );
    }
    const abort = () =>
      this.closeSubscriber(sub, new Error('Subscription aborted.'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        const record = await this.next(sub);
        yield tracked(record.id, record.data);
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      this.removeSubscriber(sub);
    }
  }

  publish(seq = this.sequence + 1, key?: string): FeedRecord {
    if (seq !== this.sequence + 1)
      throw new Error(
        `Expected sequence ${this.sequence + 1}, received ${seq}.`,
      );
    this.sequence = seq;
    const record = this.record(eventRecord(this.name, seq), seq, key);
    this.appendReplay(record);
    this.deliver(record);
    return record;
  }

  publishLarge(usage: string): FeedRecord {
    const seq = this.sequence + 1;
    const data: StreamMessage = {
      type: 'snapshot',
      cursor: seq,
      emittedAt: 1_700_000_000_000 + seq,
      snapshot: snapshot(this.generation, this.name, seq, usage),
    };
    this.sequence = seq;
    const record = this.record(data, seq);
    this.appendReplay(record);
    this.deliver(record);
    return record;
  }

  private appendReplay(record: FeedRecord): void {
    this.records.push(record);
    this.replayBytes += record.bytes;
    while (
      this.records.length > MAX_QUEUE_COUNT ||
      this.replayBytes > MAX_REPLAY_BYTES
    ) {
      const removed = this.records.shift();
      if (!removed) break;
      this.replayBytes -= removed.bytes;
    }
  }

  disconnectOldest(): void {
    const oldest = this.subscribers.values().next().value as
      | Subscriber
      | undefined;
    if (oldest)
      this.closeSubscriber(oldest, new Error('Transport disconnected.'));
  }

  rotate(generation: string): void {
    this.generation = generation;
    this.sequence = 0;
    this.records.length = 0;
    this.replayBytes = 0;
  }

  private deliver(record: FeedRecord): void {
    for (const sub of [...this.subscribers]) {
      if (sub.closed) continue;
      if (sub.resolve) {
        const resolve = sub.resolve;
        sub.resolve = undefined;
        sub.reject = undefined;
        resolve(record);
        continue;
      }
      if (record.key) {
        const previous = sub.queue.findIndex(
          (queued) => queued.key === record.key,
        );
        if (previous >= 0) {
          sub.bytes += record.bytes - sub.queue[previous].bytes;
          sub.queue[previous] = record;
          this.coalesced += 1;
          continue;
        }
      }
      sub.queue.push(record);
      sub.bytes += record.bytes;
      if (
        sub.queue.length > this.maxQueueCount ||
        sub.bytes > this.maxQueueBytes
      ) {
        this.overflowTerminations += 1;
        this.closeSubscriber(
          sub,
          new Error('Subscriber queue overflowed its count/byte bound.'),
        );
      }
    }
  }

  private next(sub: Subscriber): Promise<FeedRecord> {
    if (sub.queue.length) {
      const record = sub.queue.shift();
      if (!record)
        return Promise.reject(new Error('Queue bookkeeping failed.'));
      sub.bytes -= record.bytes;
      return Promise.resolve(record);
    }
    if (sub.closed)
      return Promise.reject(sub.error ?? new Error('Subscriber closed.'));
    return new Promise((resolve, reject) => {
      sub.resolve = resolve;
      sub.reject = reject;
    });
  }

  private closeSubscriber(sub: Subscriber, error: Error): void {
    if (sub.closed) return;
    sub.closed = true;
    sub.error = error;
    sub.queue.length = 0;
    sub.bytes = 0;
    sub.reject?.(error);
    sub.resolve = undefined;
    sub.reject = undefined;
    this.removeSubscriber(sub);
  }

  private removeSubscriber(sub: Subscriber): void {
    const removed = this.subscribers.delete(sub);
    if (removed && this.subscribers.size === 0) this.onLastListener?.();
  }
}

const SubscriptionInputSchema = Type.Object(
  {
    feed: Type.Union([
      Type.Literal('shell'),
      Type.Literal('session'),
      Type.Literal('resume'),
      Type.Literal('generation'),
    ]),
    after: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    lastEventId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);
type SubscriptionInput = Static<typeof SubscriptionInputSchema>;

const t = initTRPC
  .context<{ feeds: Record<FeedName, Feed>; token: string }>()
  .create({
    sse: {
      ping: { enabled: true, intervalMs: 10 },
      client: { reconnectAfterInactivityMs: 1000 },
    },
  });

const appRouter = t.router({
  status: t.procedure
    .input((value: unknown) =>
      parseSchema(SessionRenameRequestSchema, value, 'status input'),
    )
    .output((value: unknown) =>
      parseSchema(DashboardSnapshotResponseSchema, value, 'status output'),
    )
    .query(({ input }) => ({
      snapshot: snapshot('g1', 'shell', 0),
      cursor: input.name.length,
    })),
  stream: t.procedure
    .input((value: unknown) =>
      parseSchema(SubscriptionInputSchema, value, 'subscription input'),
    )
    .subscription(({ input, ctx, signal }) =>
      ctx.feeds[input.feed].subscribe(input.after ?? input.lastEventId, signal),
    ),
});
type AppRouter = typeof appRouter;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error(`Timed out waiting for ${label}.`));
      setTimeout(check, 2);
    };
    check();
  });
}

function decodedInput(url: string): Record<string, unknown> | undefined {
  const raw = new URL(url, 'http://localhost').searchParams.get('input');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

type FetchMode = 'same' | 'cross' | 'raw';

function headersFor(mode: FetchMode, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  if (mode !== 'raw') headers.set('x-dashboard-token', TOKEN);
  if (mode === 'cross') headers.set('origin', DEV_ORIGIN);
  return headers;
}

function wrapSseResponse(
  response: Response,
  options: {
    dropPing: boolean;
    stallAfterId?: () => string | undefined;
    onPing: () => void;
    onChunk: (bytes: number) => void;
  },
): Response {
  const reader = response.body?.getReader();
  if (!reader) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  let stalled = false;
  let chunkPhase = 0;
  let rawPending = new Uint8Array();
  const enqueueFragmentedBytes = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    bytes: Uint8Array,
  ) => {
    // Deliberately split at offsets unrelated to SSE record boundaries.
    for (let offset = 0; offset < bytes.byteLength; ) {
      const size = Math.min(
        chunkPhase++ % 2 === 0 ? 11 : 29,
        bytes.byteLength - offset,
      );
      const fragment = bytes.slice(offset, offset + size);
      options.onChunk(fragment.byteLength);
      controller.enqueue(fragment);
      offset += size;
    }
  };
  const enqueueFragmented = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ) => enqueueFragmentedBytes(controller, encoder.encode(text));
  const enqueueCoalesced = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    bytes: Uint8Array,
    flush = false,
  ) => {
    const combined = new Uint8Array(rawPending.byteLength + bytes.byteLength);
    combined.set(rawPending);
    combined.set(bytes, rawPending.byteLength);
    rawPending = combined;
    flush ||= [...rawPending].some(
      (byte, index) => byte === 10 && rawPending[index + 1] === 10,
    );
    while (rawPending.byteLength > 0) {
      const target = chunkPhase % 2 === 0 ? 11 : 29;
      if (!flush && rawPending.byteLength < target) break;
      const size = flush ? Math.min(target, rawPending.byteLength) : target;
      const fragment = rawPending.slice(0, size);
      rawPending = rawPending.slice(size);
      chunkPhase += 1;
      options.onChunk(fragment.byteLength);
      controller.enqueue(fragment);
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        if (!options.dropPing && !options.stallAfterId) {
          enqueueCoalesced(controller, new Uint8Array(), true);
        } else {
          pending += decoder.decode();
          if (pending) enqueueFragmented(controller, pending);
        }
        controller.close();
        return;
      }
      if (!options.dropPing && !options.stallAfterId) {
        if (new TextDecoder().decode(next.value).includes('event: ping'))
          options.onPing();
        enqueueCoalesced(controller, next.value);
        return;
      }
      pending += decoder.decode(next.value, { stream: true });
      const frames = pending.split('\n\n');
      pending = frames.pop() ?? '';
      let output = '';
      for (const frame of frames) {
        // Keep framing observable without logging payloads or credentials.
        if (frame.includes('event: ping')) options.onPing();
        const id = frame.match(/(?:^|\n)id: ([^\n]+)/)?.[1];
        const stallId = options.stallAfterId?.();
        if (options.dropPing && frame.includes('event: ping')) continue;
        if (!stalled) output += `${frame}\n\n`;
        if (stallId && stallId === id) stalled = true;
      }
      if (output) enqueueFragmented(controller, output);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}

describe('Phase 0 tRPC 11.18.0 Fastify SSE feasibility', () => {
  it('snapshot S; events S+1...S+n; disconnect; publish while disconnected; resume from last opaque cursor; only missed events received', async () => {
    const feeds = {
      shell: new Feed('shell'),
      session: new Feed('session'),
      resume: new Feed('resume'),
      generation: new Feed('generation'),
    } satisfies Record<FeedName, Feed>;
    let publishedWhileDisconnected = false;
    feeds.resume.onLastListener = () => undefined;

    const requestUrls: string[] = [];
    const sseRequestOrigins: Array<string | undefined> = [];
    const eventSourceUrls: string[] = [];
    const trace: Array<{ url: string; headerNames: string[] }> = [];
    const logLines: string[] = [];
    const sseChunkSizes: number[] = [];
    let pingFrames = 0;
    let generationAttempts = 0;
    let resumeAttempts = 0;
    let stallFirstResumeConnection = true;
    const allowedOrigins = [DEV_ORIGIN];
    const logSink = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(String(chunk));
        callback();
      },
    });
    const app = Fastify({ logger: { level: 'info', stream: logSink } });
    apps.push(app);
    app.addHook('onRequest', async (request, reply) => {
      requestUrls.push(request.url);
      if (request.url.startsWith('/trpc/stream'))
        sseRequestOrigins.push(request.headers.origin);
      const headerNames = Object.keys(request.headers).sort();
      trace.push({ url: request.url, headerNames });
      request.log.info({ url: request.url, headerNames }, 'dashboard request');
      const origin = request.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        reply.header('access-control-allow-origin', origin);
        reply.header(
          'access-control-allow-headers',
          'authorization, content-type, x-dashboard-token',
        );
        reply.header(
          'access-control-allow-methods',
          'GET, POST, PATCH, OPTIONS',
        );
        reply.header('vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin(origin, allowedOrigins))
          return reply.code(403).send({ error: 'Origin is not allowed.' });
        return reply.code(204).send();
      }
      const auth = authorizeRequest({
        method: request.method,
        origin,
        authorization: request.headers.authorization,
        tokenHeader: request.headers['x-dashboard-token'] as string | undefined,
        expectedToken: TOKEN,
        allowedOrigins,
      });
      if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    });
    app.all('/trpc/:path', async (request, reply) => {
      await fastifyRequestHandler({
        router: appRouter,
        req: request,
        res: reply,
        path: (request.params as { path: string }).path,
        createContext: () => ({ feeds, token: TOKEN }),
      });
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Ephemeral listener did not expose an address.');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    allowedOrigins.push(baseUrl);

    const makeFetch =
      (mode: FetchMode): typeof fetch =>
      async (input, init = {}) => {
        const headers = headersFor(mode, init);
        return fetch(input, { ...init, headers });
      };
    const eventFetch = async (
      input: string | URL,
      init: EventSourceFetchInit,
      behavior: 'normal' | 'stall' = 'normal',
      mode: FetchMode = 'same',
    ): Promise<Response> => {
      const url = String(input);
      eventSourceUrls.push(url);
      const headers = new Headers(init.headers);
      headers.set('x-dashboard-token', TOKEN);
      if (mode === 'cross') headers.set('origin', DEV_ORIGIN);
      const response = await fetch(url, { ...init, headers });
      const inputValue = decodedInput(url);
      const isResume = inputValue?.feed === 'resume';
      if (inputValue?.feed === 'generation') generationAttempts += 1;
      if (isResume) {
        resumeAttempts += 1;
        if (resumeAttempts === 2 && !publishedWhileDisconnected) {
          if (feeds.resume.metrics.listeners > 1)
            feeds.resume.disconnectOldest();
          publishedWhileDisconnected = true;
          queueMicrotask(() => {
            feeds.resume.publish(4);
            feeds.resume.publish(5);
            feeds.resume.publish(6);
          });
        }
      }
      return wrapSseResponse(response, {
        dropPing: behavior === 'stall',
        stallAfterId:
          behavior === 'stall' ? () => feeds.resume.records[2]?.id : undefined,
        onPing: () => {
          pingFrames += 1;
        },
        onChunk: (bytes) => sseChunkSizes.push(bytes),
      });
    };
    const makeEventSource = (mode: FetchMode): typeof FetchEventSource =>
      class StallingEventSource extends FetchEventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          const value = String(url);
          const shouldStall =
            stallFirstResumeConnection &&
            value.includes('feed') &&
            decodeURIComponent(value).includes('"feed":"resume"');
          if (shouldStall) stallFirstResumeConnection = false;
          super(
            url,
            shouldStall
              ? {
                  ...init,
                  fetch: (input, fetchInit) =>
                    eventFetch(input, fetchInit, 'stall', mode),
                }
              : {
                  ...init,
                  fetch: (input, fetchInit) =>
                    eventFetch(input, fetchInit, 'normal', mode),
                },
          );
        }
      };

    const makeClient = (
      mode: FetchMode,
      EventSource: typeof FetchEventSource = makeEventSource(mode),
    ) =>
      createTRPCClient<AppRouter>({
        links: [
          splitLink<AppRouter>({
            condition: (op) => op.type === 'subscription',
            true: httpSubscriptionLink({
              url: `${baseUrl}/trpc`,
              EventSource,
              eventSourceOptions: () => ({
                fetch: (input, init) => eventFetch(input, init, 'normal', mode),
              }),
            }),
            false: httpBatchLink({
              url: `${baseUrl}/trpc`,
              fetch: makeFetch(mode),
            }),
          }),
        ],
      });
    const crossClient = makeClient('cross');
    const sameClient = makeClient('same');
    const crossUntyped = getUntypedClient(crossClient);

    const subscriptions: Array<{ unsubscribe: () => void }> = [];
    const open = (input: SubscriptionInput, client = crossClient) => {
      const data: StreamMessage[] = [];
      const errors: unknown[] = [];
      const states: unknown[] = [];
      const subscription = getUntypedClient(client).subscription(
        'stream',
        input,
        {
          onData: (value) => {
            const trackedValue = value as { data?: StreamMessage };
            data.push((trackedValue.data ?? value) as StreamMessage);
          },
          onConnectionStateChange: (state) => states.push(state),
          onError: (error) => errors.push(error),
        },
      );
      subscriptions.push(subscription);
      return { data, errors, states, subscription };
    };

    try {
      // 1, 3, 6: one authenticated vanilla query, protocol parser, and auth failures.
      const queried = await crossClient.status.query({ name: 'status' });
      expect(queried.snapshot.serverId).toBe('g1');
      expect(queried.cursor).toBe(6);
      const malformed = await fetch(
        `${baseUrl}/trpc/status?input=${encodeURIComponent(JSON.stringify({ name: '' }))}`,
        {
          headers: { 'x-dashboard-token': TOKEN, origin: DEV_ORIGIN },
        },
      );
      expect(malformed.status).toBe(400);
      const missing = await fetch(
        `${baseUrl}/trpc/status?input=${encodeURIComponent(JSON.stringify({ name: 'status' }))}`,
        {
          headers: { origin: DEV_ORIGIN },
        },
      );
      const invalid = await fetch(
        `${baseUrl}/trpc/status?input=${encodeURIComponent(JSON.stringify({ name: 'status' }))}`,
        {
          headers: { 'x-dashboard-token': 'wrong-token', origin: DEV_ORIGIN },
        },
      );
      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      const bearer = await fetch(
        `${baseUrl}/trpc/status?input=${encodeURIComponent(JSON.stringify({ name: 'status' }))}`,
        {
          headers: { authorization: `Bearer ${TOKEN}`, origin: DEV_ORIGIN },
        },
      );
      expect(bearer.status).toBe(200);
      const streamUrl = `${baseUrl}/trpc/stream?input=${encodeURIComponent(JSON.stringify({ feed: 'shell' }))}`;
      const missingStream = await fetch(streamUrl, {
        headers: { origin: DEV_ORIGIN },
      });
      const invalidStream = await fetch(streamUrl, {
        headers: { 'x-dashboard-token': 'wrong-token', origin: DEV_ORIGIN },
      });
      expect(missingStream.status).toBe(401);
      expect(invalidStream.status).toBe(401);
      expect(JSON.stringify(trace)).not.toContain(TOKEN);

      // 12, 13: CORS preflight plus final-origin same-origin query behavior.
      const preflight = await fetch(`${baseUrl}/trpc/status`, {
        method: 'OPTIONS',
        headers: {
          origin: DEV_ORIGIN,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-dashboard-token',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(
        DEV_ORIGIN,
      );
      const forbiddenOrigin = await fetch(
        `${baseUrl}/trpc/status?input=${encodeURIComponent(JSON.stringify({ name: 'status' }))}`,
        {
          headers: {
            'x-dashboard-token': TOKEN,
            origin: 'http://not-allow-listed.test',
          },
        },
      );
      expect(forbiddenOrigin.status).toBe(403);
      const sameQueried = await sameClient.status.query({
        name: 'same-origin',
      });
      expect(sameQueried.snapshot.serverId).toBe('g1');
      const csrfBoundary = await fetch(`${baseUrl}/trpc/stream`, {
        method: 'PATCH',
        headers: { 'x-dashboard-token': TOKEN },
      });
      expect(csrfBoundary.status).toBe(403);

      // 2: independent shell/session subscriptions; closing one leaves the other healthy.
      const shell = open({ feed: 'shell' });
      const session = open({ feed: 'session' });
      await waitFor(
        () => shell.data.length === 1 && session.data.length === 1,
        `two initial snapshots (${JSON.stringify({ shell: shell.data, session: session.data, shellErrors: shell.errors, sessionErrors: session.errors, eventSourceUrls })})`,
      );
      expect(sseRequestOrigins).toContain(DEV_ORIGIN);
      expect(
        trace.filter(
          (entry) =>
            entry.url.startsWith('/trpc/stream') &&
            entry.headerNames.includes('x-dashboard-token'),
        ),
      ).not.toHaveLength(0);
      feeds.shell.publish(1);
      feeds.session.publish(1);
      await waitFor(
        () => shell.data.length === 2 && session.data.length === 2,
        'independent first events',
      );
      session.subscription.unsubscribe();
      await waitFor(
        () => feeds.session.metrics.listeners === 0,
        'session listener cleanup',
      );
      feeds.shell.publish(2);
      feeds.session.publish(2);
      await waitFor(() => shell.data.length === 3, 'shell remains healthy');
      expect(session.data).toHaveLength(2);
      expect(feeds.shell.metrics.listeners).toBe(1);
      shell.subscription.unsubscribe();
      await waitFor(
        () => feeds.shell.metrics.listeners === 0,
        'shell listener cleanup',
      );

      // 4, 7: tRPC's tracked() IDs resume exactly 4-6 after the first source goes idle.
      const resume = open({ feed: 'resume' });
      await waitFor(() => resume.data.length === 1, 'resume snapshot');
      feeds.resume.publish(1);
      feeds.resume.publish(2);
      feeds.resume.publish(3);
      await waitFor(() => resume.data.length >= 4, 'events 1-3').catch(
        (error) => {
          throw new Error(
            `${error instanceof Error ? error.message : error} resume=${JSON.stringify({ data: resume.data, attempts: resumeAttempts, listeners: feeds.resume.metrics.listeners })}`,
          );
        },
      );
      const lastThreeId = feeds.resume.records[2].id;
      expect(decodeId(lastThreeId)).toEqual({
        generation: 'g1',
        feed: 'resume',
        seq: 3,
      });
      expect(lastThreeId).not.toMatch(/^\d+$/);
      await waitFor(
        () => resume.data.length === 7,
        'automatic tracked resume events 4-6',
      ).catch((error) => {
        throw new Error(
          `${error instanceof Error ? error.message : error} debug=${JSON.stringify({ data: resume.data.map((item) => item.cursor), publishedWhileDisconnected, attempts: resumeAttempts, listeners: feeds.resume.metrics.listeners, urls: requestUrls.filter((url) => decodedInput(url)?.feed === 'resume') })}`,
        );
      });
      feeds.resume.publish(7);
      await waitFor(() => resume.data.length === 8, 'event 7 after reconnect');
      expect(publishedWhileDisconnected).toBe(true);
      expect(resume.data.slice(1).map((value) => value.cursor)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]);
      expect(resumeAttempts).toBe(2);
      expect(
        resume.states.filter((state) => {
          const value = state as { state?: string; error?: unknown };
          return value.state === 'connecting' && value.error != null;
        }),
      ).toHaveLength(1);
      const resumeRequest = requestUrls
        .filter((url) => decodedInput(url)?.feed === 'resume')
        .at(-1);
      expect(decodedInput(resumeRequest ?? '')?.lastEventId).toBe(lastThreeId);
      expect(
        eventSourceUrls.every((url) => !url.includes('connectionParams')),
      ).toBe(true);
      expect(eventSourceUrls.every((url) => !url.includes(TOKEN))).toBe(true);
      resume.subscription.unsubscribe();
      await waitFor(
        () => feeds.resume.metrics.listeners === 0,
        'resume listener cleanup',
      );

      // 5: automatic tRPC reconnects reset exactly once across a generation rotation.
      const generation = open({ feed: 'generation' });
      await waitFor(
        () => generation.data.length === 1,
        'generation g1 snapshot',
      );
      const oldId = feeds.generation.publish(1).id;
      await waitFor(() => generation.data.length === 2, 'generation g1 event');
      feeds.generation.disconnectOldest();
      feeds.generation.rotate('g2');
      await waitFor(
        () => generation.data.length === 3 && generationAttempts >= 2,
        'automatic g2 reset snapshot',
      );
      const resetSnapshot = generation.data[2] as Extract<
        StreamMessage,
        { type: 'snapshot' }
      >;
      expect(resetSnapshot.type).toBe('snapshot');
      expect(resetSnapshot.snapshot.serverId).toBe('g2');
      const generationRetry = eventSourceUrls
        .filter((url) => decodedInput(url)?.feed === 'generation')
        .at(-1);
      expect(decodedInput(generationRetry ?? '')?.lastEventId).toBe(oldId);
      expect(
        generation.data.filter(
          (value) => (value as { type?: string }).type === 'snapshot',
        ),
      ).toHaveLength(2);

      const g2Id = feeds.generation.publish(1).id;
      await waitFor(() => generation.data.length === 4, 'first g2 event');
      feeds.generation.disconnectOldest();
      await waitFor(
        () =>
          feeds.generation.metrics.listeners === 1 && generationAttempts >= 3,
        'automatic g2 resume listener',
      );
      const secondGenerationRetry = eventSourceUrls
        .filter((url) => decodedInput(url)?.feed === 'generation')
        .at(-1);
      expect(decodedInput(secondGenerationRetry ?? '')?.lastEventId).toBe(g2Id);
      feeds.generation.publish(2);
      await waitFor(() => generation.data.length === 5, 'g2 resumed event');
      expect(generation.data.slice(4)).toEqual([
        expect.objectContaining({ type: 'sessions', cursor: 2 }),
      ]);
      expect(
        generation.data.filter(
          (value) => (value as { type?: string }).type === 'snapshot',
        ),
      ).toHaveLength(2);
      generation.subscription.unsubscribe();
      await waitFor(
        () => feeds.generation.metrics.listeners === 0,
        'generation reconnect cleanup',
      );

      // 8, 9, 10: abort cleanup, bounded paused queues, deterministic replaceable coalescing/overflow.
      const queueFeed = new Feed('shell');
      const paused = queueFeed.subscribe(undefined);
      await paused.next();
      for (let seq = 1; seq <= 1000; seq += 1)
        queueFeed.publish(seq, 'replaceable:entity-1');
      queueFeed.publish(1001);
      expect(queueFeed.metrics.queuedCount).toBe(2);
      expect(queueFeed.metrics.queuedBytes).toBeLessThanOrEqual(
        MAX_QUEUE_BYTES,
      );
      expect(queueFeed.metrics.coalesced).toBe(999);
      const queuedOne = (await paused.next()).value as [
        string,
        StreamMessage,
        unknown,
      ];
      const queuedTwo = (await paused.next()).value as [
        string,
        StreamMessage,
        unknown,
      ];
      expect(queuedOne[1].cursor).toBe(1000);
      expect(queuedTwo[1].cursor).toBe(1001);
      await paused.return?.(undefined);
      const abortController = new AbortController();
      const aborted = queueFeed.subscribe(undefined, abortController.signal);
      await aborted.next();
      queueFeed.publish(1002);
      abortController.abort();
      await waitFor(
        () =>
          queueFeed.metrics.listeners === 0 &&
          queueFeed.metrics.queuedBytes === 0,
        'abort queue cleanup',
      );
      const overflowFeed = new Feed('session');
      const overflow = overflowFeed.subscribe(undefined);
      await overflow.next();
      for (let seq = 1; seq <= MAX_QUEUE_COUNT + 3; seq += 1)
        overflowFeed.publish(seq);
      expect(overflowFeed.metrics.queuedCount).toBe(0);
      expect(overflowFeed.metrics.queuedBytes).toBe(0);
      expect(overflowFeed.metrics.overflowTerminations).toBe(1);
      await expect(overflow.next()).rejects.toThrow('overflowed');

      // Replay has independent count and byte caps, and oversized seeded replay terminates cleanly.
      const replayFeed = new Feed('resume');
      replayFeed.publishLarge('r'.repeat(6000));
      replayFeed.publishLarge('r'.repeat(6000));
      replayFeed.publishLarge('r'.repeat(6000));
      expect(replayFeed.metrics.replayBytes).toBeLessThanOrEqual(
        MAX_REPLAY_BYTES,
      );
      expect(replayFeed.records.map((record) => record.seq)).toEqual([2, 3]);
      const seedFeed = new Feed('resume');
      const seedCursor = seedFeed.publish(1).id;
      seedFeed.publishLarge('s'.repeat(6000));
      const seededOverflow = seedFeed.subscribe(seedCursor);
      await expect(seededOverflow.next()).rejects.toThrow(
        'Subscriber seed exceeded',
      );
      expect(seedFeed.metrics.listeners).toBe(0);
      expect(seedFeed.metrics.queuedBytes).toBe(0);

      // Paused subscribers reject large queued records and clear byte accounting.
      const largePausedFeed = new Feed('session');
      const largePaused = largePausedFeed.subscribe(undefined);
      await largePaused.next();
      largePausedFeed.publishLarge('q'.repeat(6000));
      expect(largePausedFeed.metrics.queuedCount).toBe(0);
      expect(largePausedFeed.metrics.queuedBytes).toBe(0);
      expect(largePausedFeed.metrics.overflowTerminations).toBe(1);
      await expect(largePaused.next()).rejects.toThrow('overflowed');

      // 11: explicit 2 MiB browser-facing frame limit, with a valid large frame below it.
      const large = open({ feed: 'generation' }, sameClient);
      await waitFor(() => large.data.length === 1, 'large-frame subscription');
      await new Promise((resolve) => setTimeout(resolve, 50));
      const belowLimit = 'x'.repeat(1_500_000);
      feeds.generation.publishLarge(belowLimit);
      await waitFor(
        () => large.data.length >= 2,
        'large frame below limit',
      ).catch((error) => {
        throw new Error(
          `${error instanceof Error ? error.message : error} large=${JSON.stringify(
            {
              data: large.data.map(
                (value) => (value as { type?: string }).type,
              ),
              errors: large.errors.map((error) => {
                const value = error as {
                  message?: string;
                  cause?: { message?: string };
                };
                return (
                  value.message ?? value.cause?.message ?? JSON.stringify(error)
                );
              }),
              listeners: feeds.generation.metrics.listeners,
              states: large.states.map((state) => JSON.stringify(state)),
            },
          )}`,
        );
      });
      const largeSnapshot = large.data[1] as Extract<
        StreamMessage,
        { type: 'snapshot' }
      >;

      expect(largeSnapshot.type).toBe('snapshot');
      expect((largeSnapshot.snapshot.usage as string).length).toBe(
        belowLimit.length,
      );
      expect(sseChunkSizes.some((size) => size === 11)).toBe(true);
      expect(sseChunkSizes.some((size) => size === 29)).toBe(true);
      expect(sseRequestOrigins).toContain(undefined);
      expect(() =>
        feeds.generation.publishLarge('x'.repeat(FRAME_LIMIT)),
      ).toThrow(`SSE frame exceeds ${FRAME_LIMIT}`);
      large.subscription.unsubscribe();
      await waitFor(
        () => feeds.generation.metrics.listeners === 0,
        'large-frame cleanup',
      );

      // 7: real server pings keep a normal idle source alive; the only reconnect above was tRPC's inactivity option.
      const idle = open({ feed: 'shell' });
      await waitFor(() => idle.data.length === 1, 'idle snapshot');
      const pingFramesBeforeIdle = pingFrames;
      await waitFor(
        () => pingFrames >= pingFramesBeforeIdle + 2,
        'server ping frames',
      );
      expect(idle.errors).toHaveLength(0);
      expect(
        idle.states.filter((state) => {
          const value = state as { state?: string; error?: unknown };
          return value.state === 'connecting' && value.error != null;
        }),
      ).toHaveLength(0);
      expect(feeds.shell.metrics.listeners).toBe(1);
      idle.subscription.unsubscribe();
      await waitFor(() => feeds.shell.metrics.listeners === 0, 'idle cleanup');

      // Every tracked ID is opaque/generation-aware and credentials remain header-only.
      for (const feed of Object.values(feeds)) {
        for (const record of feed.records) {
          expect(record.id).not.toMatch(/^\d+$/);
          expect(record.id).not.toContain(TOKEN);
          expect(decodeId(record.id)?.generation).toBe(feed.generation);
        }
      }
      expect(JSON.stringify(trace)).not.toContain(TOKEN);
      expect(logLines.join('')).toContain('/trpc/status');
      expect(logLines.join('')).toContain('x-dashboard-token');
      expect(logLines.join('')).not.toContain(TOKEN);
      expect(JSON.stringify(requestUrls)).not.toContain(TOKEN);
      expect(JSON.stringify(eventSourceUrls)).not.toContain(TOKEN);
      expect(
        eventSourceUrls.some((url) => decodedInput(url)?.lastEventId === oldId),
      ).toBe(true);
      expect(
        eventSourceUrls.every((url) => !url.includes('connectionParams')),
      ).toBe(true);
      expect(eventSourceUrls.every((url) => !url.includes('/ws'))).toBe(true);
      expect(crossUntyped).toBeDefined();
    } finally {
      for (const subscription of subscriptions) subscription.unsubscribe();
      await waitFor(
        () =>
          Object.values(feeds).every((feed) => feed.metrics.listeners === 0),
        'all subscription cleanup',
      ).catch(() => undefined);
    }
  }, 30_000);
});
