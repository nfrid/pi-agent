import type http from 'node:http';
import type {
  DashboardEventStream,
  DashboardEventStreamRecord,
} from '../event-stream.js';

const MAX_SSE_FRAME_BYTES = 2 * 1024 * 1024;

export function serializeSseRecord(record: DashboardEventStreamRecord): string {
  return `id: ${record.cursor}\nevent: dashboard\ndata: ${JSON.stringify(record)}\n\n`;
}

export interface SseWriterOptions {
  eventStream: DashboardEventStream;
  serverId: () => string;
  sseHeartbeatMs: number;
  sseBufferBytes: number;
}

/**
 * Authenticated SSE event stream writer with replay, catch-up, and backpressure.
 */
export class SseWriter {
  private readonly eventStream: DashboardEventStream;
  private readonly serverId: () => string;
  private readonly sseHeartbeatMs: number;
  private readonly sseBufferBytes: number;
  private readonly responses = new Set<http.ServerResponse>();

  constructor(options: SseWriterOptions) {
    this.eventStream = options.eventStream;
    this.serverId = options.serverId;
    this.sseHeartbeatMs = options.sseHeartbeatMs;
    this.sseBufferBytes = options.sseBufferBytes;
  }

  handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
  ): void {
    const rawCursor =
      url.searchParams.get('cursor') ??
      (typeof request.headers['last-event-id'] === 'string'
        ? request.headers['last-event-id']
        : undefined);
    const requestedCursor =
      rawCursor === undefined || rawCursor === ''
        ? this.eventStream.cursor
        : /^\d+$/u.test(rawCursor) && Number.isSafeInteger(Number(rawCursor))
          ? Number(rawCursor)
          : undefined;
    if (requestedCursor === undefined) {
      json(response, 400, {
        error: 'Invalid event cursor.',
        code: 'invalid-cursor',
      });
      return;
    }
    const requestedServerId = url.searchParams.get('serverId');
    if (requestedServerId && requestedServerId !== this.serverId()) {
      json(response, 409, {
        error: 'The requested event generation is no longer available.',
        code: 'replay-gap',
        reason: 'server-generation-mismatch',
        serverId: this.serverId(),
        cursor: this.eventStream.cursor,
        oldestCursor: this.eventStream.oldestCursor,
      });
      return;
    }
    const replay = this.eventStream.replayAfter(requestedCursor);
    if (replay.gap) {
      json(response, 409, {
        error: 'The requested event cursor is no longer available.',
        code: 'replay-gap',
        cursor: replay.currentCursor,
        oldestCursor: replay.oldestCursor,
      });
      return;
    }
    const replayFrames = replay.events.map(serializeSseRecord);
    const replayFrameBytes = replayFrames.map((frame) =>
      Buffer.byteLength(frame),
    );
    const replayBytes = replayFrameBytes.reduce(
      (total, bytes) => total + bytes,
      0,
    );
    if (
      replayFrameBytes.some((bytes) => bytes > MAX_SSE_FRAME_BYTES) ||
      replayBytes > this.sseBufferBytes
    ) {
      json(response, 409, {
        error: 'The requested event replay is too large for this stream.',
        code: 'replay-gap',
        reason: 'replay-too-large',
        cursor: replay.currentCursor,
        oldestCursor: replay.oldestCursor,
      });
      return;
    }

    let closed = false;
    let replaying = true;
    const queued: DashboardEventStreamRecord[] = [];
    let queuedBytes = 0;
    const pendingWrites: string[] = [];
    let pendingBytes = 0;
    let backpressured = false;
    let drainAttached = false;
    let unsubscribe: () => void = () => undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.responses.delete(response);
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      if (drainAttached) response.off('drain', flushWrites);
      pendingWrites.length = 0;
      pendingBytes = 0;
    };
    const closeSlowClient = () => {
      cleanup();
      if (!response.writableEnded) response.destroy();
    };
    const flushWrites = () => {
      if (closed || response.writableEnded) return;
      backpressured = false;
      drainAttached = false;
      while (pendingWrites.length > 0) {
        const value = pendingWrites[0];
        const bytes = Buffer.byteLength(value);
        if (response.writableLength + bytes > this.sseBufferBytes) {
          backpressured = true;
          if (!drainAttached) {
            drainAttached = true;
            response.once('drain', flushWrites);
          }
          return;
        }
        try {
          pendingWrites.shift();
          pendingBytes -= bytes;
          if (!response.write(value)) {
            backpressured = true;
            if (!drainAttached) {
              drainAttached = true;
              response.once('drain', flushWrites);
            }
            return;
          }
        } catch {
          closeSlowClient();
          return;
        }
      }
    };
    const writeRaw = (value: string): boolean => {
      if (closed || response.writableEnded) return false;
      const bytes = Buffer.byteLength(value);
      if (bytes > MAX_SSE_FRAME_BYTES || bytes > this.sseBufferBytes) {
        closeSlowClient();
        return false;
      }
      if (backpressured || pendingWrites.length > 0) {
        if (
          response.writableLength + pendingBytes + bytes >
          this.sseBufferBytes
        ) {
          closeSlowClient();
          return false;
        }
        pendingWrites.push(value);
        pendingBytes += bytes;
        return true;
      }
      if (response.writableLength + bytes > this.sseBufferBytes) {
        closeSlowClient();
        return false;
      }
      try {
        if (!response.write(value)) {
          backpressured = true;
          if (!drainAttached) {
            drainAttached = true;
            response.once('drain', flushWrites);
          }
        }
        return true;
      } catch {
        closeSlowClient();
        return false;
      }
    };
    const writeRecord = (record: DashboardEventStreamRecord): boolean =>
      writeRaw(serializeSseRecord(record));
    const writeHeartbeat = () => writeRaw(': heartbeat\n\n');
    const queueRecord = (record: DashboardEventStreamRecord): boolean => {
      const bytes = Buffer.byteLength(serializeSseRecord(record));
      if (
        bytes > MAX_SSE_FRAME_BYTES ||
        queuedBytes + bytes > this.sseBufferBytes
      )
        return false;
      queued.push(record);
      queuedBytes += bytes;
      return true;
    };
    const onRecord = (record: DashboardEventStreamRecord) => {
      if (replaying) {
        if (!queueRecord(record)) closeSlowClient();
        return;
      }
      writeRecord(record);
    };
    unsubscribe = this.eventStream.subscribe(onRecord);
    // Close the small replayAfter/subscribe race before committing 200 headers.
    // Records published in that interval are replayed after the original
    // window; subsequent records are already captured by the subscription.
    const catchup = this.eventStream.replayAfter(replay.currentCursor);
    const catchupFits =
      !catchup.gap && catchup.events.every((record) => queueRecord(record));
    if (
      !catchupFits ||
      replayBytes + queuedBytes + Buffer.byteLength(': heartbeat\n\n') >
        this.sseBufferBytes
    ) {
      unsubscribe();
      json(response, 409, {
        error: 'The requested event replay changed before streaming began.',
        code: 'replay-gap',
        reason: 'replay-too-large',
        cursor: this.eventStream.cursor,
        oldestCursor: this.eventStream.oldestCursor,
      });
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders?.();
    this.responses.add(response);
    response.once('close', cleanup);
    request.once('aborted', cleanup);
    if (!writeHeartbeat()) return;
    for (const frame of replayFrames) {
      if (!writeRaw(frame)) return;
    }
    replaying = false;
    for (const record of queued) {
      if (!writeRecord(record)) return;
    }
    heartbeat = setInterval(
      writeHeartbeat,
      Math.max(1_000, this.sseHeartbeatMs),
    );
    heartbeat.unref?.();
  }

  destroyAll(): void {
    for (const response of this.responses) destroySseResponse(response);
    this.responses.clear();
  }
}

function json(
  response: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  const text = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(text);
}

function destroySseResponse(response: http.ServerResponse): void {
  if (response.writableEnded) return;
  try {
    response.destroy();
  } catch {
    try {
      response.end();
    } catch {
      /* best effort during shutdown */
    }
  }
}
