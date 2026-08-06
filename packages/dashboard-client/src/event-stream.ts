import {
  type DashboardStreamMessage,
  tryParseDashboardStreamMessage,
} from '@pi-dashboard/protocol';
import type { DashboardHttpClient } from './http-client.js';
import { DashboardHttpError, ReplayGapError } from './http-client.js';

export const SSE_FRAME_LIMIT = 2 * 1024 * 1024;
export const SSE_RECORDS_PER_YIELD = 32;
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 30_000;

function abortError(): DOMException {
  return new DOMException(
    'The dashboard event stream was aborted.',
    'AbortError',
  );
}

export function yieldToBrowser(fallbackMs = 100): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    let settled = false;
    let frame: number | undefined;
    const fallback = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (frame !== undefined && typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(frame);
      resolve();
    }, fallbackMs);
    frame = requestAnimationFrame(() => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    });
  });
}

/** Parse one long-lived SSE response. The parser intentionally ignores id/event fields. */
export async function consumeSseResponse(
  response: Response,
  onRecord: (record: DashboardStreamMessage) => void | Promise<void>,
  signal?: AbortSignal,
  parse: (value: unknown) => DashboardStreamMessage = (value) => {
    const record = tryParseDashboardStreamMessage(value);
    if (!record) throw new Error('Dashboard returned an invalid event.');
    return record;
  },
  yieldControl: () => Promise<void> = yieldToBrowser,
): Promise<number> {
  const body = response.body;
  if (!body) throw new Error('Dashboard event stream has no body.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = '';
  let dataLines: string[] = [];
  let frameBytes = 0;
  let records = 0;
  let reachedEof = false;
  let aborted = Boolean(signal?.aborted);
  const onAbort = () => {
    aborted = true;
    void reader.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const dispatch = async () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    const record = parse(JSON.parse(data));
    await onRecord(record);
    records += 1;
    // Proxies and browsers may coalesce many SSE frames into one read chunk.
    // Yield in bounded batches: yielding for every token record caps the
    // consumer near the display refresh rate and can permanently starve later
    // state/question records during a fast model stream.
    if (records % SSE_RECORDS_PER_YIELD === 0) await yieldControl();
  };
  const processLine = async (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      await dispatch();
      frameBytes = 0;
      return;
    }
    frameBytes += encoder.encode(`${line}\n`).byteLength;
    if (frameBytes > SSE_FRAME_LIMIT)
      throw new Error('Dashboard SSE frame exceeds its size limit.');
    if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  };
  try {
    while (true) {
      if (aborted) throw abortError();
      const { done, value } = await reader.read();
      if (aborted) throw abortError();
      if (value) lineBuffer += decoder.decode(value, { stream: !done });
      if (
        lineBuffer.indexOf('\n') < 0 &&
        encoder.encode(lineBuffer).byteLength > SSE_FRAME_LIMIT
      )
        throw new Error('Dashboard SSE frame exceeds its size limit.');
      let newline = lineBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        await processLine(line);
        newline = lineBuffer.indexOf('\n');
      }
      if (encoder.encode(lineBuffer).byteLength > SSE_FRAME_LIMIT)
        throw new Error('Dashboard SSE frame exceeds its size limit.');
      if (!done) continue;
      const trailing = decoder.decode();
      if (trailing) lineBuffer += trailing;
      if (lineBuffer) {
        await processLine(lineBuffer);
        lineBuffer = '';
      }
      await dispatch();
      reachedEof = true;
      return records;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!reachedEof) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function shouldReconnectAfterConnectUnwind(
  reconnectRequested: boolean,
  stopped: boolean,
  online: boolean,
): boolean {
  return reconnectRequested && !stopped && online;
}

export function nextReconnectDelay(current: number): number {
  return Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, current * 2));
}

export function reconnectDelayWithJitter(
  delay: number,
  random = Math.random,
): number {
  return Math.round(delay * (0.8 + random() * 0.4));
}

export interface DashboardEventStreamOptions {
  client: DashboardHttpClient;
  getCursor: () => number;
  getServerId: () => string | undefined;
  onRecord: (record: DashboardStreamMessage) => void;
  onReplayGap: () => Promise<void>;
  onState: (state: 'connecting' | 'connected' | 'reconnecting') => void;
  onError: (error: Error | undefined) => void;
  isOnline?: () => boolean;
  random?: () => number;
}

/** Owns one authenticated, reconnecting, long-lived SSE connection. */
export class DashboardEventStream {
  private stopped = true;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private reconnectWhenUnwound = false;
  private retryDelay = RECONNECT_MIN_MS;
  private readonly options: DashboardEventStreamOptions;

  constructor(options: DashboardEventStreamOptions) {
    this.options = options;
  }

  start(): () => void {
    const wasConnecting = this.connecting;
    this.stop();
    this.stopped = false;
    if (wasConnecting) this.reconnectWhenUnwound = true;
    else void this.connect();
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  reconnect(): void {
    if (this.stopped || !this.online()) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.retryDelay = RECONNECT_MIN_MS;
    if (this.connecting) {
      // A fetch-backed SSE consumer can remain pending forever after a mobile
      // browser suspends the page. Abort that connection instead of waiting for
      // it to unwind on its own; finally starts a fresh request from the latest
      // accepted cursor.
      this.reconnectWhenUnwound = true;
      this.controller?.abort();
      return;
    }
    void this.connect();
  }

  private online(): boolean {
    return (
      this.options.isOnline?.() ??
      (typeof navigator === 'undefined' || navigator.onLine)
    );
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.options.onState('reconnecting');
    this.options.onError(new Error('Live updates disconnected; retrying…'));
    if (!this.online()) return;
    const delay = reconnectDelayWithJitter(
      this.retryDelay,
      this.options.random,
    );
    this.retryDelay = nextReconnectDelay(this.retryDelay);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || !this.online()) return;
    this.connecting = true;
    this.options.onState('connecting');
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await this.options.client.events(
        this.options.getCursor(),
        controller.signal,
        this.options.getServerId(),
      );
      if (this.stopped) return;
      // A successful response means the live channel is connected even when
      // the daemon is idle and sends only heartbeat comments.
      this.options.onState('connected');
      this.options.onError(undefined);
      this.retryDelay = RECONNECT_MIN_MS;
      await consumeSseResponse(
        response,
        (record) => {
          if (
            this.stopped ||
            controller.signal.aborted ||
            this.controller !== controller
          )
            return;
          this.options.onRecord(record);
        },
        controller.signal,
        (value) => {
          const record = tryParseDashboardStreamMessage(value);
          if (!record) throw new Error('Dashboard returned an invalid event.');
          return record;
        },
      );
      if (!this.stopped) this.scheduleReconnect();
    } catch (cause) {
      if (
        this.stopped ||
        (cause instanceof DOMException && cause.name === 'AbortError')
      )
        return;
      if (
        cause instanceof DashboardHttpError &&
        (cause.status === 401 || cause.status === 403)
      ) {
        this.options.onError(cause);
        this.stop();
        return;
      }
      if (cause instanceof ReplayGapError) {
        this.options.onError(
          new Error('Live replay window expired; resynchronizing…'),
        );
        await this.options.onReplayGap();
        this.retryDelay = RECONNECT_MIN_MS;
      } else if (cause instanceof Error) this.options.onError(cause);
      else this.options.onError(new Error(String(cause)));
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
      if (this.controller === controller) this.controller = undefined;
      if (this.reconnectWhenUnwound) {
        this.reconnectWhenUnwound = false;
        if (!this.stopped && this.online()) void this.connect();
      }
    }
  }
}
