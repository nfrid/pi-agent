import {
  type BrowserSnapshot,
  type DashboardMessage,
  type SessionApiResponse,
  tryParseBrowserSnapshot,
  tryParseDashboardMessage,
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

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const EVENT_REVISION_LIMIT = 256;

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
  events: readonly DashboardEvent[];
  /** Advances synchronously when an accepted socket event arrives. */
  eventGeneration: { readonly current: number };
  reconnectNonce: number;
  connectionState: 'connecting' | 'connected' | 'reconnecting';
}

/**
 * The browser accepts snapshots in revision order and serializes event delivery
 * into an ordered list. Fetches are still allowed to overlap, but an older
 * response can never replace a newer response or a websocket snapshot.
 */
export function useDashboard(): DashboardState {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>();
  const [error, setError] = useState<string>();
  const [usageError, setUsageError] = useState<string>();
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [connectionState, setConnectionState] =
    useState<DashboardState['connectionState']>('connecting');
  const requestSerial = useRef(0);
  const latestResponse = useRef(0);
  const usageRequestSerial = useRef(0);
  const latestUsageResponse = useRef(0);
  const acceptedServerId = useRef<string | undefined>(undefined);
  const acceptedRevision = useRef(-1);
  const eventRevisions = useRef(new Set<number>());
  const eventGeneration = useRef(0);
  const eventRevisionOrder = useRef<number[]>([]);
  const liveDisconnected = useRef(false);
  const authoritativeSocketServerId = useRef<string | undefined>(undefined);

  const acceptSnapshot = useCallback((next: BrowserSnapshot): void => {
    if (acceptedServerId.current !== next.serverId) {
      acceptedServerId.current = next.serverId;
      acceptedRevision.current = -1;
      eventRevisions.current.clear();
      eventRevisionOrder.current = [];
      setEvents([]);
    }
    if (!shouldAcceptRevision(acceptedRevision.current, next.revision)) return;
    acceptedRevision.current = next.revision;
    setSnapshot((current) =>
      current &&
      current.serverId === next.serverId &&
      !shouldAcceptRevision(current.revision, next.revision)
        ? current
        : next,
    );
    if (!liveDisconnected.current) setError(undefined);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestSerial.current;
    const requestServerId = acceptedServerId.current;
    try {
      const next = asBrowserSnapshot(await api<unknown>('/api/snapshot'));
      if (!next) throw new Error('Dashboard returned an invalid snapshot.');
      if (requestId < latestResponse.current) return;
      latestResponse.current = requestId;
      // A request issued before a daemon transition can complete after the new
      // websocket is authoritative. Never roll the UI back to that retired
      // server generation.
      if (
        authoritativeSocketServerId.current !== undefined &&
        authoritativeSocketServerId.current !== next.serverId
      )
        return;
      if (
        acceptedServerId.current !== requestServerId &&
        acceptedServerId.current !== next.serverId
      )
        return;
      acceptSnapshot(next);
    } catch (cause) {
      if (requestId < latestResponse.current) return;
      latestResponse.current = requestId;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [acceptSnapshot]);

  const refreshUsage = useCallback(async (): Promise<void> => {
    const requestId = ++usageRequestSerial.current;
    const requestServerId = acceptedServerId.current;
    try {
      const response = await api<{ usage?: unknown; error?: string }>(
        '/api/usage',
      );
      if (requestId < latestUsageResponse.current) return;
      latestUsageResponse.current = requestId;
      if (acceptedServerId.current !== requestServerId) return;
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
    void refresh();
    void refreshUsage();
    const url = new URL(`${base || window.location.origin}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let connectTimer: number | undefined;
    let resyncTimer: number | undefined;
    let eventFlushTimer: number | undefined;
    let stopped = false;
    let pendingEvents: DashboardEvent[] = [];
    let retryDelay = RECONNECT_MIN_MS;
    const flushEvents = () => {
      eventFlushTimer = undefined;
      const batch = pendingEvents.filter(
        (event) =>
          event.serverId === undefined ||
          event.serverId === acceptedServerId.current,
      );
      pendingEvents = [];
      if (batch.length > 0)
        setEvents((current) => [...current, ...batch].slice(-128));
    };
    const queueEvent = (event: DashboardEvent): void => {
      if (
        event.serverId !== undefined &&
        acceptedServerId.current !== undefined &&
        event.serverId !== acceptedServerId.current
      )
        return;
      if (typeof event.revision === 'number') {
        const eventType = event.event?.type;
        const transcriptDelta =
          eventType?.startsWith('message.') || eventType?.startsWith('tool.');
        // State snapshots do not contain transcripts, so an HTTP snapshot may
        // overtake a transcript delta without making that delta redundant.
        if (!transcriptDelta && event.revision < acceptedRevision.current)
          return;
        if (eventRevisions.current.has(event.revision)) return;
        eventRevisions.current.add(event.revision);
        eventRevisionOrder.current.push(event.revision);
        while (eventRevisionOrder.current.length > EVENT_REVISION_LIMIT) {
          const expired = eventRevisionOrder.current.shift();
          if (expired !== undefined) eventRevisions.current.delete(expired);
        }
      }
      eventGeneration.current += 1;
      pendingEvents = enqueueStreamEvent(pendingEvents, event);
      eventFlushTimer ??= window.setTimeout(flushEvents, 50);
    };
    const scheduleResync = () => {
      if (stopped || resyncTimer !== undefined) return;
      resyncTimer = window.setTimeout(() => {
        resyncTimer = undefined;
        void refresh();
      }, 100);
    };
    const scheduleReconnect = () => {
      if (stopped || timer !== undefined) return;
      liveDisconnected.current = true;
      setConnectionState('reconnecting');
      setError('Live updates disconnected; retrying…');
      if (!navigator.onLine) return;
      const delay = reconnectDelayWithJitter(retryDelay);
      retryDelay = nextReconnectDelay(retryDelay);
      timer = window.setTimeout(() => {
        timer = undefined;
        connect();
      }, delay);
    };
    const connect = () => {
      if (stopped) return;
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      const token = dashboardToken();
      if (!token) return;
      setConnectionState('connecting');
      const candidate = new WebSocket(url);
      let candidateServerId: string | undefined;
      socket = candidate;
      candidate.onopen = () => {
        if (stopped || socket !== candidate) return;
        candidate.send(JSON.stringify({ type: 'auth', token }));
      };
      candidate.onmessage = (event) => {
        if (stopped || socket !== candidate) return;
        try {
          if (typeof event.data !== 'string')
            throw new Error('Invalid message');
          const parsed: unknown = JSON.parse(event.data);
          const message = tryParseDashboardMessage(parsed);
          if (!message) throw new Error('Invalid message');
          const next =
            message.type === 'snapshot' ? message.snapshot : undefined;
          const envelopeServerId =
            message.type === 'event' ? message.serverId : next?.serverId;
          if (
            message.type === 'event' &&
            message.snapshot &&
            message.serverId !== message.snapshot.serverId
          )
            return;
          if (
            candidateServerId !== undefined &&
            envelopeServerId !== undefined &&
            envelopeServerId !== candidateServerId
          )
            return;
          if (next) {
            const authenticated = candidateServerId === undefined;
            if (authenticated) {
              candidateServerId = next.serverId;
              authoritativeSocketServerId.current = next.serverId;
            } else if (next.serverId !== candidateServerId) return;
            liveDisconnected.current = false;
            acceptSnapshot(next);
            retryDelay = RECONNECT_MIN_MS;
            setConnectionState('connected');
            if (authenticated) setReconnectNonce((value) => value + 1);
          }
          if (message.type === 'event') {
            if (message.snapshot) acceptSnapshot(message.snapshot);
            queueEvent(message);
          }
        } catch {
          scheduleResync();
        }
      };
      candidate.onclose = () => {
        if (socket !== candidate) return;
        socket = undefined;
        if (authoritativeSocketServerId.current === candidateServerId)
          authoritativeSocketServerId.current = undefined;
        scheduleReconnect();
      };
      candidate.onerror = () => candidate.close();
    };
    // Delay initial connection by one task so React Strict Mode can complete its
    // development-only mount/unmount probe without closing a CONNECTING socket.
    const reconnectNow = () => {
      if (stopped || !navigator.onLine) return;
      retryDelay = RECONNECT_MIN_MS;
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      if (!socket) connect();
    };
    const refreshVisible = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      // Session transcripts are fetched separately from snapshots. Foreground
      // transitions reconcile any deltas missed while the page was suspended.
      setReconnectNonce((value) => value + 1);
      reconnectNow();
    };
    const pauseOffline = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
    window.addEventListener('online', reconnectNow);
    window.addEventListener('offline', pauseOffline);
    document.addEventListener('visibilitychange', refreshVisible);
    connectTimer = window.setTimeout(connect, 0);
    return () => {
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('offline', pauseOffline);
      document.removeEventListener('visibilitychange', refreshVisible);
      stopped = true;
      if (timer) window.clearTimeout(timer);
      if (connectTimer) window.clearTimeout(connectTimer);
      if (resyncTimer) window.clearTimeout(resyncTimer);
      if (eventFlushTimer) window.clearTimeout(eventFlushTimer);
      pendingEvents = [];
      const activeSocket = socket;
      socket = undefined;
      authoritativeSocketServerId.current = undefined;
      if (activeSocket) {
        activeSocket.onmessage = null;
        activeSocket.onerror = null;
        activeSocket.onclose = null;
        if (activeSocket.readyState === WebSocket.CONNECTING)
          activeSocket.onopen = () => activeSocket.close();
        else activeSocket.close();
      }
    };
  }, [acceptSnapshot, refresh, refreshUsage]);

  return {
    snapshot,
    error,
    usageError,
    refresh,
    events,
    eventGeneration,
    reconnectNonce,
    connectionState,
  };
}
