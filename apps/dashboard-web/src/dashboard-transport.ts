import {
  type BrowserSnapshot,
  type DashboardEventEnvelope,
  type DashboardMessage,
  type DashboardStreamMessage,
  type SessionApiResponse,
  tryParseBrowserSnapshot,
  tryParseDashboardStreamMessage,
  tryParseSessionApiResponse,
} from '@pi-dashboard/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export const base =
  (import.meta.env.VITE_DASHBOARD_URL as string | undefined)?.replace(
    /\/$/,
    '',
  ) ?? '';

export function dashboardToken(): string | undefined {
  try {
    return localStorage.getItem('pi-dashboard-token') ?? undefined;
  } catch {
    return undefined;
  }
}

export type AppError = Error & { code?: string };
export type DashboardEvent = Extract<DashboardMessage, { type: 'event' }>;
/** Canonical SSE reducer input. The legacy websocket event remains exported for v1 callers. */
export type DashboardLiveEvent = DashboardEventEnvelope;
export type DashboardStreamRecord = DashboardStreamMessage;

/**
 * v1 HTTP fixtures predate the shared snapshot contract. Keep these three
 * defaults at the transport boundary; all nested validation belongs to the
 * shared protocol parser.
 */
function normalizeLegacyBrowserSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  return {
    ...snapshot,
    ...(snapshot.serverId === undefined ? { serverId: 'legacy' } : {}),
    ...(snapshot.revision === undefined ? { revision: 0 } : {}),
    ...(snapshot.cursor === undefined ? { cursor: 0 } : {}),
    ...(snapshot.unread === undefined ? { unread: [] } : {}),
  };
}

function streamEventKey(event: DashboardEvent): string | undefined {
  const bridgeEvent = event.event;
  const type = bridgeEvent.type;
  if (!type.startsWith('message.') && !type.startsWith('tool.'))
    return undefined;
  const family = type.split('.')[0];
  const payload =
    family === 'message' && 'message' in bridgeEvent
      ? bridgeEvent.message
      : family === 'tool' && 'tool' in bridgeEvent
        ? bridgeEvent.tool
        : undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return undefined;
  const identity =
    family === 'message'
      ? (payload as { messageId?: unknown }).messageId
      : (payload as { toolCallId?: unknown }).toolCallId;
  if (typeof identity !== 'string' || !identity) return undefined;
  const sessionId = 'sessionId' in bridgeEvent ? bridgeEvent.sessionId : '';
  return `${event.runtimeId}:${sessionId}:${family}:${identity}`;
}

export function enqueueStreamEvent(
  pending: readonly DashboardEvent[],
  event: DashboardEvent,
): DashboardEvent[] {
  const key = streamEventKey(event);
  if (key && event.event?.type?.endsWith('.updated')) {
    const existing = pending.findIndex(
      (candidate) =>
        streamEventKey(candidate) === key &&
        candidate.event?.type?.endsWith('.updated'),
    );
    return existing < 0
      ? [...pending, event]
      : pending.map((candidate, index) =>
          index === existing ? event : candidate,
        );
  }
  const withoutSuperseded =
    key && event.event?.type?.endsWith('.finished')
      ? pending.filter(
          (candidate) =>
            streamEventKey(candidate) !== key ||
            !candidate.event?.type?.endsWith('.updated'),
        )
      : pending;
  return [...withoutSuperseded, event];
}

export type SessionResponse = SessionApiResponse;

export function asSessionResponse(value: unknown): SessionResponse | undefined {
  return tryParseSessionApiResponse(value);
}

export function asBrowserSnapshot(value: unknown): BrowserSnapshot | undefined {
  return tryParseBrowserSnapshot(normalizeLegacyBrowserSnapshot(value));
}

export function asDashboardStreamMessage(
  value: unknown,
): DashboardStreamMessage | undefined {
  return tryParseDashboardStreamMessage(value);
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export function nextReconnectDelay(current: number): number {
  return Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, current * 2));
}

export function reconnectDelayWithJitter(
  delay: number,
  random = Math.random,
): number {
  return Math.round(delay * (0.8 + random() * 0.4));
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      (body as { error?: string }).error ??
        `Request failed (${response.status})`,
    ) as AppError;
    Object.assign(error, body);
    throw error;
  }
  return body as T;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = dashboardToken();
  return readApiResponse<T>(
    await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-dashboard-token': token } : {}),
        ...(init?.headers ?? {}),
      },
    }),
  );
}

/** Send a multipart request without overriding the browser's boundary header. */
export async function multipartApi<T>(
  path: string,
  body: FormData,
): Promise<T> {
  const token = dashboardToken();
  return readApiResponse<T>(
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: token ? { 'x-dashboard-token': token } : {},
      body,
    }),
  );
}

export function shouldAcceptRevision(
  currentRevision: number,
  nextRevision: number,
): boolean {
  return nextRevision > currentRevision;
}

export interface DashboardState {
  snapshot: BrowserSnapshot | undefined;
  error: string | undefined;
  usageError: string | undefined;
  refresh: () => Promise<void>;
  /** A bounded set of canonical reducer inputs newer than recent snapshots. */
  events: readonly DashboardLiveEvent[];
  cursor: number;
  /** Increments only after an authoritative replay-gap resynchronization. */
  resyncNonce: number;
  connectionState: 'connecting' | 'connected' | 'reconnecting';
}

const LIVE_EVENT_BUFFER_LIMIT = 256;

class ReplayGapError extends Error {
  readonly code = 'replay-gap';
}

async function readSseResponse(
  response: Response,
): Promise<DashboardStreamMessage> {
  const body = response.body;
  if (!body) throw new Error('Dashboard event stream has no body.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        const parsed = asDashboardStreamMessage(JSON.parse(data));
        if (!parsed) throw new Error('Dashboard returned an invalid event.');
        await reader.cancel();
        return parsed;
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (done) throw new Error('Dashboard event stream ended.');
  }
}

/**
 * Fetch one SSE record. The server uses a short-lived response and the hook
 * reconnects explicitly, which lets it send the last accepted cursor without
 * putting credentials in a URL.
 */
async function fetchNextSseRecord(
  cursor: number,
  signal: AbortSignal,
): Promise<DashboardStreamMessage> {
  const token = dashboardToken();
  if (!token) throw new Error('Authentication required.');
  const response = await fetch(
    `${base}/api/events?cursor=${encodeURIComponent(cursor)}`,
    {
      headers: {
        accept: 'text/event-stream',
        'x-dashboard-token': token,
      },
      signal,
    },
  );
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
    };
    if (body.code === 'replay-gap') throw new ReplayGapError();
  }
  if (!response.ok)
    throw new Error(`Event stream failed (${response.status}).`);
  return readSseResponse(response);
}

export function useDashboard(): DashboardState {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>();
  const [error, setError] = useState<string>();
  const [usageError, setUsageError] = useState<string>();
  const [events, setEvents] = useState<DashboardLiveEvent[]>([]);
  const [resyncNonce, setResyncNonce] = useState(0);
  const [connectionState, setConnectionState] =
    useState<DashboardState['connectionState']>('connecting');
  const acceptedCursor = useRef(0);
  const usageRequestSerial = useRef(0);
  const latestUsageResponse = useRef(0);

  const acceptSnapshot = useCallback((next: BrowserSnapshot): void => {
    if (next.cursor < acceptedCursor.current) return;
    acceptedCursor.current = next.cursor;
    setSnapshot((current) =>
      current && current.cursor > next.cursor ? current : next,
    );
    setError(undefined);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = asBrowserSnapshot(await api<unknown>('/api/snapshot'));
      if (!next) throw new Error('Dashboard returned an invalid snapshot.');
      acceptSnapshot(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [acceptSnapshot]);

  const refreshUsage = useCallback(async (): Promise<void> => {
    const requestId = ++usageRequestSerial.current;
    try {
      const response = await api<{ usage?: unknown; error?: string }>(
        '/api/usage',
      );
      if (requestId < latestUsageResponse.current) return;
      latestUsageResponse.current = requestId;
      if (response.error) {
        setUsageError(response.error);
        return;
      }
      setUsageError(undefined);
      if (typeof response.usage !== 'undefined')
        setSnapshot((current) =>
          current ? { ...current, usage: response.usage } : current,
        );
    } catch (cause) {
      if (requestId < latestUsageResponse.current) return;
      latestUsageResponse.current = requestId;
      setUsageError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let reconnectTimer: number | undefined;
    let connectTimer: number | undefined;
    let controller: AbortController | undefined;
    let connecting = false;
    let retryDelay = RECONNECT_MIN_MS;

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer !== undefined) return;
      setConnectionState('reconnecting');
      setError('Live updates disconnected; retrying…');
      if (!navigator.onLine) return;
      const delay = reconnectDelayWithJitter(retryDelay);
      retryDelay = nextReconnectDelay(retryDelay);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
    };
    const handleReplayGap = async () => {
      setError('Live replay window expired; resynchronizing…');
      await refresh();
      setResyncNonce((value) => value + 1);
      retryDelay = RECONNECT_MIN_MS;
    };
    const acceptRecord = (record: DashboardStreamMessage): void => {
      if (record.cursor <= acceptedCursor.current) return;
      if (record.cursor > acceptedCursor.current + 1) {
        throw new ReplayGapError();
      }
      if ('type' in record && record.type === 'snapshot') {
        acceptSnapshot(record.snapshot);
        return;
      }
      acceptedCursor.current = record.cursor;
      if (record.snapshot) acceptSnapshot(record.snapshot);
      setEvents((current) =>
        [...current, record as DashboardLiveEvent].slice(
          -LIVE_EVENT_BUFFER_LIMIT,
        ),
      );
    };
    const connect = async (): Promise<void> => {
      if (stopped || connecting || !dashboardToken()) return;
      connecting = true;
      setConnectionState('connecting');
      controller = new AbortController();
      let continueImmediately = false;
      try {
        const record = await fetchNextSseRecord(
          acceptedCursor.current,
          controller.signal,
        );
        if (stopped) return;
        acceptRecord(record);
        setConnectionState('connected');
        setError(undefined);
        retryDelay = RECONNECT_MIN_MS;
        // A response carries one record; reconnect immediately to preserve a
        // simple bounded read and make each request's cursor explicit.
        continueImmediately = true;
      } catch (cause) {
        if (
          stopped ||
          (cause instanceof DOMException && cause.name === 'AbortError')
        )
          return;
        if (cause instanceof ReplayGapError) await handleReplayGap();
        scheduleReconnect();
      } finally {
        connecting = false;
        controller = undefined;
        if (continueImmediately && !stopped) void connect();
      }
    };
    const reconnectNow = () => {
      if (stopped || !navigator.onLine) return;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      retryDelay = RECONNECT_MIN_MS;
      if (!connecting) void connect();
    };
    const pauseOffline = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      controller?.abort();
    };
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };
    void refresh();
    void refreshUsage();
    window.addEventListener('online', reconnectNow);
    window.addEventListener('offline', pauseOffline);
    document.addEventListener('visibilitychange', refreshVisible);
    connectTimer = window.setTimeout(() => void connect(), 0);
    return () => {
      stopped = true;
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('offline', pauseOffline);
      document.removeEventListener('visibilitychange', refreshVisible);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (connectTimer !== undefined) window.clearTimeout(connectTimer);
      controller?.abort();
    };
  }, [acceptSnapshot, refresh, refreshUsage]);

  return {
    snapshot,
    error,
    usageError,
    refresh,
    events,
    cursor: acceptedCursor.current,
    resyncNonce,
    connectionState,
  };
}
