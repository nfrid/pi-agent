import type {
  BrowserSnapshot,
  SessionIndexEntry,
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
export type DashboardEvent = {
  type?: string;
  revision?: number;
  runtimeId?: string;
  snapshot?: BrowserSnapshot;
  event?: {
    type?: string;
    sessionId?: string;
    message?: unknown;
    tool?: unknown;
    interaction?: unknown;
    session?: { id?: string; name?: string; title?: string };
  };
};

export type SessionResponse = {
  metadata: SessionIndexEntry;
  entries: unknown[];
};

export function asSessionResponse(value: unknown): SessionResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const response = value as Partial<SessionResponse>;
  const metadata = response.metadata as Partial<SessionIndexEntry> | undefined;
  if (
    !metadata ||
    typeof metadata.id !== 'string' ||
    typeof metadata.cwd !== 'string' ||
    !Array.isArray(response.entries)
  )
    return undefined;
  return { metadata: metadata as SessionIndexEntry, entries: response.entries };
}

export function asBrowserSnapshot(value: unknown): BrowserSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const snapshot = value as Partial<BrowserSnapshot>;
  if (
    !Array.isArray(snapshot.runtimes) ||
    !Array.isArray(snapshot.workspaces) ||
    !Array.isArray(snapshot.sessions)
  )
    return undefined;
  return {
    ...snapshot,
    serverId:
      typeof snapshot.serverId === 'string' ? snapshot.serverId : 'legacy',
    revision: typeof snapshot.revision === 'number' ? snapshot.revision : 0,
    runtimes: snapshot.runtimes,
    workspaces: snapshot.workspaces,
    sessions: snapshot.sessions,
    unread: Array.isArray(snapshot.unread) ? snapshot.unread : [],
  } as BrowserSnapshot;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = dashboardToken();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-dashboard-token': token } : {}),
      ...(init?.headers ?? {}),
    },
  });
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

export function shouldAcceptRevision(
  currentRevision: number,
  nextRevision: number,
): boolean {
  return nextRevision >= currentRevision;
}

export interface DashboardState {
  snapshot: BrowserSnapshot | undefined;
  error: string | undefined;
  usageError: string | undefined;
  refresh: () => Promise<void>;
  events: readonly DashboardEvent[];
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

  const acceptSnapshot = useCallback((next: BrowserSnapshot): void => {
    if (acceptedServerId.current !== next.serverId) {
      acceptedServerId.current = next.serverId;
      acceptedRevision.current = -1;
      eventRevisions.current.clear();
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
    setError(undefined);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestSerial.current;
    try {
      const next = asBrowserSnapshot(await api<unknown>('/api/snapshot'));
      if (!next) throw new Error('Dashboard returned an invalid snapshot.');
      if (requestId < latestResponse.current) return;
      latestResponse.current = requestId;
      acceptSnapshot(next);
    } catch (cause) {
      if (requestId < latestResponse.current) return;
      latestResponse.current = requestId;
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
    void refresh();
    void refreshUsage();
    const url = new URL(`${base || window.location.origin}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let connectTimer: number | undefined;
    let stopped = false;
    const queueEvent = (event: DashboardEvent): void => {
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
      }
      setEvents((current) => [...current, event].slice(-128));
    };
    const connect = () => {
      if (stopped) return;
      setConnectionState('connecting');
      socket = new WebSocket(url);
      socket.onopen = () => {
        setConnectionState('connected');
        setReconnectNonce((value) => value + 1);
        void refresh();
        void refreshUsage();
        const token = dashboardToken();
        if (token) socket?.send(JSON.stringify({ type: 'auth', token }));
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as DashboardEvent;
          const next =
            message.type === 'snapshot'
              ? asBrowserSnapshot(message.snapshot)
              : undefined;
          if (next) acceptSnapshot(next);
          const eventMessage =
            message.event && typeof message.event === 'object'
              ? message
              : undefined;
          if (eventMessage) {
            if (message.snapshot) {
              const eventSnapshot = asBrowserSnapshot(message.snapshot);
              if (eventSnapshot) acceptSnapshot(eventSnapshot);
            }
            queueEvent(eventMessage);
          } else if (!next && message.type !== 'snapshot') {
            void refresh();
          }
        } catch {
          void refresh();
        }
      };
      socket.onclose = () => {
        if (!stopped) {
          setConnectionState('reconnecting');
          setError('Live updates disconnected; retrying…');
          timer = window.setTimeout(() => {
            void refresh();
            connect();
          }, 1000);
        }
      };
      socket.onerror = () => socket?.close();
    };
    // Delay initial connection by one task so React Strict Mode can complete its
    // development-only mount/unmount probe without closing a CONNECTING socket.
    connectTimer = window.setTimeout(connect, 0);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      if (connectTimer) window.clearTimeout(connectTimer);
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      else if (socket) {
        socket.onopen = () => socket?.close();
        socket.onerror = null;
        socket.onclose = null;
      }
    };
  }, [acceptSnapshot, refresh, refreshUsage]);

  return {
    snapshot,
    error,
    usageError,
    refresh,
    events,
    reconnectNonce,
    connectionState,
  };
}
