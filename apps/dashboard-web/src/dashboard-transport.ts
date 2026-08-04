import type { DashboardState } from '@pi-dashboard/client';
import {
  api,
  asBrowserSnapshot,
  asDashboardStreamMessage,
  asSessionResponse,
  consumeSseResponse,
  dashboardBaseUrl,
  dashboardToken,
  multipartApi,
  nextReconnectDelay,
  reconnectDelayWithJitter,
  shouldReconnectAfterConnectUnwind,
  snapshotAcceptance,
  useDashboard,
} from '@pi-dashboard/client';
import type {
  DashboardEventEnvelope,
  DashboardMessage,
  DashboardStreamMessage,
  SessionApiResponse,
} from '@pi-dashboard/protocol';

/**
 * Compatibility facade for Phase 2 callers. HTTP, auth, SSE parsing and the
 * live store now belong to @pi-dashboard/client; this file only keeps the
 * historical web imports stable while pages migrate.
 */
export const base = dashboardBaseUrl;
export type { DashboardState };
export {
  api,
  asBrowserSnapshot,
  asDashboardStreamMessage,
  asSessionResponse,
  consumeSseResponse,
  dashboardToken,
  multipartApi,
  nextReconnectDelay,
  reconnectDelayWithJitter,
  shouldReconnectAfterConnectUnwind,
  snapshotAcceptance,
  useDashboard,
};

export type AppError = Error & { code?: string; status?: number };
export type DashboardEvent = Extract<DashboardMessage, { type: 'event' }>;
export type DashboardLiveEvent = DashboardEventEnvelope;
export type DashboardStreamRecord = DashboardStreamMessage;
export type SessionResponse = SessionApiResponse;

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

export function shouldAcceptRevision(
  currentRevision: number,
  nextRevision: number,
): boolean {
  return nextRevision > currentRevision;
}

export type { DashboardState as LegacyDashboardState };
export { dashboardToken as getDashboardToken };
