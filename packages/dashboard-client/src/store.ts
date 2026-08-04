import {
  hydrateTranscript,
  reduceTranscriptEvent,
  type TranscriptProjection,
} from '@pi-dashboard/domain';
import type {
  BrowserSnapshot,
  DashboardEventEnvelope,
  DashboardStreamMessage,
  RuntimeSnapshot,
  SessionApiResponse,
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { useSyncExternalStore } from 'react';
import { DashboardEventStream } from './event-stream.js';
import { type DashboardHttpClient, ReplayGapError } from './http-client.js';

export const LIVE_BUFFER_LIMIT = 256;

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface DashboardLiveState {
  snapshot?: BrowserSnapshot;
  serverId?: string;
  revision: number;
  cursor: number;
  connection: {
    status: ConnectionStatus;
    lastCursor: number;
    error?: string;
  };
  workspacesById: Readonly<Record<string, WorkspaceTarget>>;
  workspaceOrder: readonly string[];
  runtimesById: Readonly<Record<string, RuntimeSnapshot>>;
  sessionsById: Readonly<Record<string, SessionIndexEntry>>;
  /** Monotonic semantic updates used by transcript views; pages do not consume raw envelopes. */
  sessionChangeById: Readonly<Record<string, number>>;
  sessionReplacementByRuntimeId: Readonly<Record<string, string>>;
  sessionReplacementBySessionId: Readonly<Record<string, string>>;
  notificationsById: Readonly<
    Record<string, BrowserSnapshot['unread'][number]>
  >;
  transcriptsBySessionId: Readonly<Record<string, TranscriptProjection>>;
  cursorHistory: readonly number[];
  recentEvents: readonly DashboardEventEnvelope[];
  resyncNonce: number;
  usageError?: string;
}

export interface SnapshotAcceptanceProvenance {
  source?: 'http' | 'sse';
  requestGeneration?: number;
  currentGeneration?: number;
}

export function snapshotAcceptance(
  currentServerId: string | undefined,
  currentCursor: number,
  next: BrowserSnapshot,
  provenance: SnapshotAcceptanceProvenance = {},
): { accepted: boolean; reset: boolean } {
  if (currentServerId !== undefined && currentServerId !== next.serverId) {
    if (
      provenance.source === 'http' &&
      (provenance.requestGeneration === undefined ||
        provenance.currentGeneration === undefined ||
        provenance.requestGeneration !== provenance.currentGeneration)
    )
      return { accepted: false, reset: false };
    return { accepted: true, reset: true };
  }
  return { accepted: next.cursor >= currentCursor, reset: false };
}

function indexed<T extends { id: string }>(
  items: readonly T[],
): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

function runtimeIndex(
  items: readonly RuntimeSnapshot[],
): Record<string, RuntimeSnapshot> {
  return Object.fromEntries(items.map((item) => [item.runtimeId, item]));
}

function emptyState(): DashboardLiveState {
  return {
    revision: 0,
    cursor: 0,
    connection: { status: 'connecting', lastCursor: 0 },
    workspacesById: {},
    workspaceOrder: [],
    runtimesById: {},
    sessionsById: {},
    sessionChangeById: {},
    sessionReplacementByRuntimeId: {},
    sessionReplacementBySessionId: {},
    notificationsById: {},
    transcriptsBySessionId: {},
    cursorHistory: [],
    recentEvents: [],
    resyncNonce: 0,
  };
}

function sessionIdForEvent(
  envelope: DashboardEventEnvelope,
): string | undefined {
  if (envelope.sessionId) return envelope.sessionId;
  const event = envelope.event;
  if ('sessionId' in event && typeof event.sessionId === 'string')
    return event.sessionId;
  if ('session' in event && typeof event.session?.id === 'string')
    return event.session.id;
  return undefined;
}

/**
 * The sole normalized live-state owner. It has no rendering or route logic;
 * React consumes it through useSyncExternalStore selectors.
 */
export class DashboardLiveStore {
  private state: DashboardLiveState = emptyState();
  private listeners = new Set<() => void>();
  private generation = 0;
  private stream?: DashboardEventStream;

  getGeneration(): number {
    return this.generation;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DashboardLiveState => this.state;

  private publish(next: DashboardLiveState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  setConnection(status: ConnectionStatus, error?: string): void {
    this.publish({
      ...this.state,
      connection: {
        status,
        lastCursor: this.state.cursor,
        ...(error ? { error } : {}),
      },
    });
  }

  setUsageError(error: string | undefined): void {
    this.publish({
      ...this.state,
      ...(error ? { usageError: error } : { usageError: undefined }),
    });
  }

  setError(error: string | undefined): void {
    this.publish({
      ...this.state,
      connection: {
        ...this.state.connection,
        ...(error ? { error } : { error: undefined }),
      },
    });
  }

  installSnapshot(
    next: BrowserSnapshot,
    provenance: SnapshotAcceptanceProvenance = {},
  ): boolean {
    const decision = snapshotAcceptance(
      this.state.serverId,
      this.state.cursor,
      next,
      {
        ...provenance,
        currentGeneration: this.generation,
      },
    );
    if (!decision.accepted) return false;
    if (decision.reset) {
      this.generation += 1;
      this.publish({
        ...emptyState(),
        snapshot: next,
        serverId: next.serverId,
        revision: next.revision,
        cursor: next.cursor,
        connection: this.state.connection,
        workspacesById: indexed(next.workspaces),
        workspaceOrder: next.workspaces.map((item) => item.id),
        runtimesById: runtimeIndex(next.runtimes),
        sessionsById: indexed(next.sessions),
        sessionChangeById: {},
        sessionReplacementByRuntimeId: {},
        sessionReplacementBySessionId: {},
        notificationsById: indexed(next.unread),
        cursorHistory: [next.cursor].slice(-LIVE_BUFFER_LIMIT),
      });
      return true;
    }
    const current = this.state.snapshot;
    if (current && current.cursor > next.cursor) return false;
    this.publish({
      ...this.state,
      snapshot: next,
      serverId: next.serverId,
      revision: next.revision,
      cursor: next.cursor,
      connection: { ...this.state.connection, lastCursor: next.cursor },
      workspacesById: indexed(next.workspaces),
      workspaceOrder: next.workspaces.map((item) => item.id),
      runtimesById: runtimeIndex(next.runtimes),
      sessionsById: indexed(next.sessions),
      sessionChangeById: this.state.sessionChangeById,
      sessionReplacementByRuntimeId: this.state.sessionReplacementByRuntimeId,
      sessionReplacementBySessionId: this.state.sessionReplacementBySessionId,
      notificationsById: indexed(next.unread),
      cursorHistory: [...this.state.cursorHistory, next.cursor].slice(
        -LIVE_BUFFER_LIMIT,
      ),
    });
    return true;
  }

  acceptStreamRecord(record: DashboardStreamMessage): boolean {
    if ('type' in record && record.type === 'snapshot') {
      if (
        record.snapshot.serverId === this.state.serverId &&
        record.cursor <= this.state.cursor
      )
        return false;
      const accepted = this.installSnapshot(record.snapshot, { source: 'sse' });
      if (!accepted) return false;
      this.publish({
        ...this.state,
        cursor: record.cursor,
        cursorHistory: [...this.state.cursorHistory, record.cursor].slice(
          -LIVE_BUFFER_LIMIT,
        ),
      });
      return true;
    }
    const envelope = record as DashboardEventEnvelope;
    const priorCursor = this.state.cursor;
    const previousRuntimeSessionId = envelope.runtimeId
      ? this.state.runtimesById[envelope.runtimeId]?.session.id
      : undefined;
    if (
      envelope.snapshot &&
      envelope.snapshot.serverId !== this.state.serverId &&
      !this.installSnapshot(envelope.snapshot, { source: 'sse' })
    )
      return false;
    if (envelope.cursor <= priorCursor) return false;
    if (
      envelope.cursor > priorCursor + 1 &&
      this.state.serverId !== undefined &&
      !envelope.snapshot
    )
      throw new ReplayGapError();
    if (envelope.snapshot)
      this.installSnapshot(envelope.snapshot, { source: 'sse' });
    const sessionId = sessionIdForEvent(envelope);
    const currentProjection = sessionId
      ? this.state.transcriptsBySessionId[sessionId]
      : undefined;
    let transcripts = this.state.transcriptsBySessionId;
    if (sessionId) {
      const canSeedSnapshot =
        envelope.event.type === 'session.snapshot' &&
        (envelope.event.session as { entriesComplete?: boolean })
          .entriesComplete === true;
      const baseProjection =
        currentProjection ??
        (canSeedSnapshot ? hydrateTranscript([], sessionId) : undefined);
      if (baseProjection) {
        const nextProjection = reduceTranscriptEvent(baseProjection, envelope);
        if (nextProjection !== baseProjection)
          transcripts = { ...transcripts, [sessionId]: nextProjection };
      }
    }
    let sessionsById = this.state.sessionsById;
    let nextSnapshot = this.state.snapshot;
    let sessionChangeById = this.state.sessionChangeById;
    let sessionReplacementByRuntimeId =
      this.state.sessionReplacementByRuntimeId;
    let sessionReplacementBySessionId =
      this.state.sessionReplacementBySessionId;
    const event = envelope.event;
    const semanticSessionUpdate =
      Boolean(sessionId) &&
      (event.type.startsWith('message.') ||
        event.type.startsWith('tool.') ||
        event.type === 'agent.settled' ||
        event.type === 'session.changed' ||
        event.type === 'session.snapshot');
    if (sessionId && semanticSessionUpdate)
      sessionChangeById = {
        ...sessionChangeById,
        [sessionId]: (sessionChangeById[sessionId] ?? 0) + 1,
      };
    if (
      sessionId &&
      (event.type === 'session.changed' || event.type === 'session.snapshot') &&
      'session' in event
    ) {
      const current = sessionsById[sessionId];
      if (current) {
        const metadata = {
          ...current,
          ...(event.session.name === undefined
            ? {}
            : { name: event.session.name }),
          ...(event.session.title === undefined
            ? {}
            : { title: event.session.title }),
        };
        sessionsById = { ...sessionsById, [sessionId]: metadata };
        if (nextSnapshot)
          nextSnapshot = {
            ...nextSnapshot,
            sessions: nextSnapshot.sessions.map((item) =>
              item.id === sessionId ? metadata : item,
            ),
          };
      }
      if (envelope.runtimeId)
        sessionReplacementByRuntimeId = {
          ...sessionReplacementByRuntimeId,
          [envelope.runtimeId]: sessionId,
        };
      if (previousRuntimeSessionId && previousRuntimeSessionId !== sessionId)
        sessionReplacementBySessionId = {
          ...sessionReplacementBySessionId,
          [previousRuntimeSessionId]: sessionId,
        };
    }
    this.publish({
      ...this.state,
      snapshot: nextSnapshot,
      sessionsById,
      sessionChangeById,
      sessionReplacementByRuntimeId,
      sessionReplacementBySessionId,
      cursor: envelope.cursor,
      connection: { ...this.state.connection, lastCursor: envelope.cursor },
      cursorHistory: [...this.state.cursorHistory, envelope.cursor].slice(
        -LIVE_BUFFER_LIMIT,
      ),
      recentEvents: [...this.state.recentEvents, envelope].slice(
        -LIVE_BUFFER_LIMIT,
      ),
      transcriptsBySessionId: transcripts,
    });
    return true;
  }

  /** Install a session HTTP result, then replay buffered events newer than its cursor. */
  hydrateSession(
    response: SessionApiResponse,
  ): TranscriptProjection | undefined {
    if (
      response.serverId !== undefined &&
      this.state.serverId !== undefined &&
      response.serverId !== this.state.serverId
    )
      return undefined;
    const snapshotCursor = response.cursor ?? this.state.cursor;
    if (
      !sessionCursorRangeCovered(
        snapshotCursor,
        this.state.cursor,
        this.state.cursorHistory,
      )
    )
      return undefined;
    const currentProjection =
      this.state.transcriptsBySessionId[response.metadata.id];
    const sessionEvents = this.state.recentEvents.filter((envelope) => {
      if (sessionIdForEvent(envelope) !== response.metadata.id) return false;
      // The HTTP branch belongs to its advertised runtime generation. Older
      // generations cannot refine it; a newer generation after the response
      // cursor is still replayed and may intentionally replace it.
      return (
        response.runtimeEpoch === undefined ||
        envelope.runtimeEpoch === undefined ||
        envelope.runtimeEpoch === response.runtimeEpoch ||
        envelope.cursor > snapshotCursor
      );
    });
    // The HTTP cursor covers event publication, not necessarily Pi's append to
    // JSONL. Replay the bounded live buffer so a terminal tool event emitted
    // just before persistence is reconciled, and so a complete /tree snapshot
    // can replace stale append-only data already returned by HTTP.
    const firstReplayCursor = sessionEvents[0]?.cursor;
    const replayCursor =
      firstReplayCursor === undefined
        ? snapshotCursor
        : Math.min(snapshotCursor, firstReplayCursor) - 1;
    const firstResponseEpochSeq = sessionEvents
      .filter(
        (envelope) =>
          response.runtimeEpoch !== undefined &&
          envelope.runtimeEpoch === response.runtimeEpoch &&
          envelope.runtimeSeq !== undefined,
      )
      .map((envelope) => envelope.runtimeSeq as number)
      .sort((a, b) => a - b)[0];
    const baselineRuntimeSeq =
      firstResponseEpochSeq === undefined
        ? response.runtimeSeq
        : firstResponseEpochSeq - 1;
    let projection = hydrateTranscript(response.entries, response.metadata.id, {
      cursor: replayCursor,
      ...(response.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: response.runtimeEpoch }),
      ...(baselineRuntimeSeq === undefined
        ? {}
        : { runtimeSeq: baselineRuntimeSeq }),
    });
    for (const envelope of sessionEvents)
      if (envelope.cursor > projection.lastCursor)
        projection = reduceTranscriptEvent(projection, envelope);
    const retiredEpochs = new Set([
      ...projection.retiredEpochs,
      ...(currentProjection?.retiredEpochs ?? []),
    ]);
    if (
      currentProjection?.runtimeEpoch !== undefined &&
      currentProjection.runtimeEpoch !== projection.runtimeEpoch
    )
      retiredEpochs.add(currentProjection.runtimeEpoch);
    const responseRuntimeSeq =
      response.runtimeEpoch !== undefined &&
      response.runtimeEpoch === projection.runtimeEpoch
        ? (response.runtimeSeq ?? -1)
        : -1;
    const currentRuntimeSeq =
      currentProjection?.runtimeEpoch !== undefined &&
      currentProjection.runtimeEpoch === projection.runtimeEpoch
        ? currentProjection.lastRuntimeSeq
        : -1;
    projection = {
      ...projection,
      ...(projection.runtimeEpoch === undefined &&
      currentProjection?.runtimeEpoch !== undefined
        ? { runtimeEpoch: currentProjection.runtimeEpoch }
        : {}),
      lastCursor: Math.max(
        projection.lastCursor,
        snapshotCursor,
        currentProjection?.lastCursor ?? -1,
      ),
      lastRuntimeSeq: Math.max(
        projection.lastRuntimeSeq,
        responseRuntimeSeq,
        currentRuntimeSeq,
      ),
      retiredEpochs: [...retiredEpochs],
    };
    const currentMetadata = this.state.sessionsById[response.metadata.id];
    const metadata = currentMetadata
      ? { ...response.metadata, ...currentMetadata }
      : response.metadata;
    this.publish({
      ...this.state,
      sessionsById: {
        ...this.state.sessionsById,
        [response.metadata.id]: metadata,
      },
      transcriptsBySessionId: {
        ...this.state.transcriptsBySessionId,
        [response.metadata.id]: projection,
      },
    });
    return projection;
  }

  applyMutationResult(
    result: unknown,
    requestGeneration = this.generation,
  ): void {
    if (result && typeof result === 'object' && 'snapshot' in result) {
      const snapshot = (result as { snapshot?: unknown }).snapshot;
      if (snapshot)
        this.installSnapshot(snapshot as BrowserSnapshot, {
          source: 'http',
          requestGeneration,
        });
    }
    if (
      result &&
      typeof result === 'object' &&
      'metadata' in result &&
      'entries' in result
    )
      this.hydrateSession(result as SessionApiResponse);
  }

  updateUsage(usage: unknown): void {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    this.publish({ ...this.state, snapshot: { ...snapshot, usage } });
  }

  updateSessionMetadata(
    id: string,
    patch: Pick<SessionIndexEntry, 'name' | 'title'>,
  ): void {
    const current = this.state.sessionsById[id];
    if (!current) return;
    const metadata = { ...current, ...patch };
    const sessionsById = { ...this.state.sessionsById, [id]: metadata };
    const snapshot = this.state.snapshot;
    this.publish({
      ...this.state,
      sessionsById,
      snapshot: snapshot
        ? {
            ...snapshot,
            sessions: snapshot.sessions.map((session) =>
              session.id === id ? { ...session, ...patch } : session,
            ),
          }
        : undefined,
    });
  }

  markNotificationRead(id: string): void {
    const current = this.state.notificationsById[id];
    if (!current) return;
    const next = { ...this.state.notificationsById };
    delete next[id];
    this.publish({
      ...this.state,
      notificationsById: next,
      snapshot: this.state.snapshot
        ? {
            ...this.state.snapshot,
            unread: this.state.snapshot.unread.filter((item) => item.id !== id),
          }
        : undefined,
    });
  }

  clearServer(): void {
    this.generation += 1;
    this.publish(emptyState());
  }

  connect(client: DashboardHttpClient): () => void {
    this.stream?.stop();
    this.stream = new DashboardEventStream({
      client,
      getCursor: () => this.state.cursor,
      getServerId: () => this.state.serverId,
      onRecord: (record) => {
        this.acceptStreamRecord(record);
        this.setError(undefined);
      },
      onReplayGap: async () => {
        const requestGeneration = this.generation;
        try {
          const snapshot = await client.snapshot();
          this.installSnapshot(snapshot, {
            source: 'http',
            requestGeneration,
            currentGeneration: this.generation,
          });
          this.publish({
            ...this.state,
            resyncNonce: this.state.resyncNonce + 1,
          });
        } catch (cause) {
          this.setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
      onState: (status) => this.setConnection(status),
      onError: (error) => this.setError(error?.message),
    });
    return this.stream.start();
  }

  reconnect(): void {
    this.stream?.reconnect();
  }
}

export function sessionCursorRangeCovered(
  snapshotCursor: number,
  currentCursor: number,
  cursorHistory: readonly number[],
): boolean {
  if (currentCursor <= snapshotCursor) return true;
  let expected = snapshotCursor + 1;
  for (const cursor of cursorHistory) {
    if (cursor < expected) continue;
    if (cursor !== expected) return false;
    expected += 1;
    if (expected > currentCursor) return true;
  }
  return expected > currentCursor;
}

export function useDashboardStore<T>(
  store: DashboardLiveStore,
  selector: (state: DashboardLiveState) => T,
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot()),
  );
}

export const selectSnapshot = (state: DashboardLiveState) => state.snapshot;
export const selectTranscript =
  (sessionId: string) => (state: DashboardLiveState) =>
    state.transcriptsBySessionId[sessionId];
export const selectSession =
  (sessionId: string) => (state: DashboardLiveState) =>
    state.sessionsById[sessionId];
export const selectSessionChange =
  (sessionId: string) => (state: DashboardLiveState) =>
    state.sessionChangeById[sessionId] ?? 0;
export const selectSessionReplacement =
  (sessionId: string) => (state: DashboardLiveState) =>
    state.sessionReplacementBySessionId[sessionId];
export const selectRuntime =
  (runtimeId: string) => (state: DashboardLiveState) =>
    state.runtimesById[runtimeId];
