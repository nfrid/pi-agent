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
  serverId?: string;
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

function isDashboardEventEnvelope(value: unknown): value is DashboardEvent {
  if (!isRecord(value)) return false;
  if (
    (value.type !== undefined && typeof value.type !== 'string') ||
    (value.serverId !== undefined && typeof value.serverId !== 'string') ||
    (value.revision !== undefined &&
      (!Number.isSafeInteger(value.revision) ||
        (value.revision as number) < 0)) ||
    (value.runtimeId !== undefined && typeof value.runtimeId !== 'string') ||
    (value.event !== undefined && !isRecord(value.event))
  )
    return false;
  if (!isRecord(value.event)) return true;
  if (typeof value.event.type !== 'string') return false;
  if (
    value.event.sessionId !== undefined &&
    typeof value.event.sessionId !== 'string'
  )
    return false;
  if (value.event.session !== undefined) {
    if (
      !isRecord(value.event.session) ||
      typeof value.event.session.id !== 'string' ||
      !optionalString(value.event.session.name) ||
      !optionalString(value.event.session.title)
    )
      return false;
  }
  return true;
}

export function asSessionResponse(value: unknown): SessionResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const response = value as Partial<SessionResponse>;
  const metadata = response.metadata as Partial<SessionIndexEntry> | undefined;
  if (
    !isRecord(metadata) ||
    typeof metadata.id !== 'string' ||
    typeof metadata.cwd !== 'string' ||
    !optionalString(metadata.file) ||
    !optionalString(metadata.workspaceId) ||
    !optionalString(metadata.name) ||
    !optionalString(metadata.title) ||
    !optionalString(metadata.activeRuntimeId) ||
    (metadata.updatedAt !== undefined && !isFiniteNumber(metadata.updatedAt)) ||
    (metadata.entryCount !== undefined &&
      !Number.isSafeInteger(metadata.entryCount)) ||
    !Array.isArray(response.entries)
  )
    return undefined;
  return {
    metadata: {
      ...metadata,
      file: metadata.file ?? '',
      updatedAt: metadata.updatedAt ?? 0,
    } as SessionIndexEntry,
    entries: response.entries,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSession(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.file === 'string' &&
    typeof value.cwd === 'string' &&
    optionalString(value.workspaceId) &&
    optionalString(value.name) &&
    optionalString(value.title) &&
    optionalString(value.activeRuntimeId) &&
    isFiniteNumber(value.updatedAt) &&
    (value.entryCount === undefined || Number.isSafeInteger(value.entryCount))
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isInteraction(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.type === 'ask_user' &&
    typeof value.question === 'string' &&
    Array.isArray(value.choices) &&
    value.choices.every(
      (choice) =>
        isRecord(choice) &&
        typeof choice.label === 'string' &&
        typeof choice.value === 'string' &&
        optionalString(choice.description) &&
        optionalString(choice.preview),
    ) &&
    typeof value.allowCustom === 'boolean' &&
    optionalString(value.customLabel) &&
    isFiniteNumber(value.createdAt)
  );
}

function isRuntime(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.runtimeId !== 'string' ||
    (value.ownership !== 'external' && value.ownership !== 'managed') ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.cwd !== 'string' ||
    !['idle', 'working', 'waiting', 'aborting', 'stopping', 'failed'].includes(
      value.liveState as string,
    ) ||
    !isRecord(value.session) ||
    typeof value.session.id !== 'string' ||
    !optionalString(value.session.file) ||
    !optionalString(value.session.name) ||
    !optionalString(value.session.title) ||
    !optionalString(value.session.cwd) ||
    !optionalString(value.session.leafId) ||
    !Array.isArray(value.session.entries) ||
    !Array.isArray(value.pendingInteractions) ||
    !value.pendingInteractions.every(isInteraction) ||
    !optionalString(value.lastError) ||
    (value.online !== undefined && typeof value.online !== 'boolean') ||
    (value.lastSeenAt !== undefined && !isFiniteNumber(value.lastSeenAt))
  )
    return false;
  if (
    value.model !== undefined &&
    (!isRecord(value.model) ||
      typeof value.model.provider !== 'string' ||
      typeof value.model.model !== 'string' ||
      !optionalString(value.model.thinking))
  )
    return false;
  return (
    value.contextUsage === undefined ||
    (isRecord(value.contextUsage) &&
      (value.contextUsage.tokens === null ||
        isFiniteNumber(value.contextUsage.tokens)) &&
      isFiniteNumber(value.contextUsage.contextWindow) &&
      (value.contextUsage.percent === undefined ||
        value.contextUsage.percent === null ||
        isFiniteNumber(value.contextUsage.percent)))
  );
}

function isWorkspace(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    typeof value.canonicalPath === 'string' &&
    optionalString(value.gitRoot) &&
    optionalString(value.tmuxSession) &&
    ['tmux', 'sesh-config', 'zoxide', 'directory'].includes(
      value.source as string,
    ) &&
    typeof value.active === 'boolean'
  );
}

function isNotification(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    ['waiting', 'failed', 'runtime-exited', 'settled'].includes(
      value.kind as string,
    ) &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    optionalString(value.runtimeId) &&
    optionalString(value.sessionId) &&
    isFiniteNumber(value.createdAt) &&
    (value.readAt === undefined || isFiniteNumber(value.readAt))
  );
}

export function asBrowserSnapshot(value: unknown): BrowserSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const serverId =
    typeof value.serverId === 'string' ? value.serverId : 'legacy';
  const revision = value.revision === undefined ? 0 : value.revision;
  const unread = value.unread === undefined ? [] : value.unread;
  if (
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0 ||
    !Array.isArray(value.runtimes) ||
    !value.runtimes.every(isRuntime) ||
    !Array.isArray(value.workspaces) ||
    !value.workspaces.every(isWorkspace) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(isSession) ||
    !Array.isArray(unread) ||
    !unread.every(isNotification)
  )
    return undefined;
  return {
    ...value,
    serverId,
    revision: revision as number,
    runtimes: value.runtimes,
    workspaces: value.workspaces,
    sessions: value.sessions,
    unread,
  } as unknown as BrowserSnapshot;
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
    let stopped = false;
    let retryDelay = RECONNECT_MIN_MS;
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
      setEvents((current) => [...current, event].slice(-128));
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
          if (!isDashboardEventEnvelope(parsed))
            throw new Error('Invalid message');
          const message = parsed;
          const next =
            message.type === 'snapshot'
              ? asBrowserSnapshot(message.snapshot)
              : undefined;
          if (message.type === 'snapshot' && !next)
            throw new Error('Invalid snapshot');
          if (
            message.serverId !== undefined &&
            next !== undefined &&
            message.serverId !== next.serverId
          )
            return;
          const envelopeServerId = message.serverId ?? next?.serverId;
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
          const eventMessage =
            message.event && typeof message.event === 'object'
              ? message
              : undefined;
          if (eventMessage) {
            if (message.snapshot) {
              const eventSnapshot = asBrowserSnapshot(message.snapshot);
              if (!eventSnapshot) throw new Error('Invalid event snapshot');
              if (
                candidateServerId !== undefined &&
                eventSnapshot.serverId !== candidateServerId
              )
                return;
              acceptSnapshot(eventSnapshot);
            }
            queueEvent(eventMessage);
          } else if (!next && message.type !== 'snapshot') {
            scheduleResync();
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
    reconnectNonce,
    connectionState,
  };
}
