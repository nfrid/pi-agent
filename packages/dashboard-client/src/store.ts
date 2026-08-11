import {
  applyRuntimeEvent,
  applyTransportOrdering,
  createRuntimeReducerState,
  hydrateTranscript,
  type RuntimeReducerState,
  reduceTranscriptEvent,
  type TranscriptProjection,
} from '@pi-dashboard/domain';
import {
  type BrowserSnapshot,
  type CheckoutSummary,
  type DashboardEventEnvelope,
  type DashboardStreamMessage,
  deriveSessionTitle,
  type ProjectSummary,
  type RunSummary,
  type RuntimeSnapshot,
  type SessionApiResponse,
  type SessionIndexEntry,
  type ThreadSummary,
  type WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { useSyncExternalStore } from 'react';
import { DashboardEventStream } from './event-stream.js';
import { type DashboardHttpClient, ReplayGapError } from './http-client.js';

export const LIVE_BUFFER_LIMIT = 256;
export const LIVE_RENDER_INTERVAL_MS = 32;
export const INITIAL_REPLAY_OVERLAP = 128;
const BOOTSTRAP_RETRY_MIN_MS = 500;
const BOOTSTRAP_RETRY_MAX_MS = 30_000;

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface DashboardLiveState {
  /** Transport metadata is retained separately from hydrated entities. */
  serverId?: string;
  revision: number;
  snapshotCursor: number;
  usage?: unknown;
  projects?: readonly ProjectSummary[];
  checkouts?: readonly CheckoutSummary[];
  threads?: readonly ThreadSummary[];
  runs?: readonly RunSummary[];
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
  /** First-turn titles are rendered before Pi persists or publishes session metadata. */
  optimisticSessionTitlesById: Readonly<Record<string, string>>;
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
  /** A replay-gap snapshot establishes the next SSE cursor baseline. */
  rebaseCursor?: boolean;
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

function mergePrependedTranscript(
  current: TranscriptProjection,
  older: TranscriptProjection,
): TranscriptProjection {
  const items: Record<string, TranscriptProjection['items'][string]> = {
    ...older.items,
  };
  for (const [id, item] of Object.entries(current.items)) {
    const previous = items[id];
    if (previous?.kind === 'tool' && item.kind === 'tool') {
      items[id] = {
        ...previous,
        ...item,
        // A page boundary commonly contains the tool start followed by a
        // newer generic result. Keep the useful start metadata while the live
        // result/status remains authoritative.
        name:
          item.name === 'tool' && previous.name !== 'tool'
            ? previous.name
            : item.name,
        ...(item.arguments === undefined && previous.arguments !== undefined
          ? { arguments: previous.arguments }
          : {}),
        ...(item.result === undefined && previous.result !== undefined
          ? { result: previous.result }
          : {}),
        ...(item.isError === undefined && previous.isError !== undefined
          ? { isError: previous.isError }
          : {}),
        ...(item.data === undefined && previous.data !== undefined
          ? { data: previous.data }
          : {}),
      };
    } else items[id] = item;
  }
  const currentIds = new Set(current.order);
  return {
    ...current,
    order: [
      ...older.order.filter((id) => !currentIds.has(id)),
      ...current.order,
    ],
    items,
  };
}

function emptyState(): DashboardLiveState {
  return {
    revision: 0,
    snapshotCursor: 0,
    cursor: 0,
    connection: { status: 'connecting', lastCursor: 0 },
    workspacesById: {},
    workspaceOrder: [],
    runtimesById: {},
    sessionsById: {},
    optimisticSessionTitlesById: {},
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

function liveMessageIdentity(envelope: DashboardEventEnvelope):
  | {
      messageId: string;
      role: string;
      content: unknown;
      timestamp?: string | number;
    }
  | undefined {
  const event = envelope.event;
  if (
    event.type !== 'message.started' &&
    event.type !== 'message.updated' &&
    event.type !== 'message.finished'
  )
    return undefined;
  if (!event.message || typeof event.message !== 'object') return undefined;
  const message = event.message as Record<string, unknown>;
  if (typeof message.messageId !== 'string' || typeof message.role !== 'string')
    return undefined;
  const timestamp = message.timestamp;
  return {
    messageId: message.messageId,
    role: message.role,
    content: message.content,
    ...((typeof timestamp === 'string' && timestamp.length > 0) ||
    (typeof timestamp === 'number' && Number.isFinite(timestamp))
      ? { timestamp }
      : {}),
  };
}

function messageContentKey(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function persistedMessageIdForLive(
  projection: TranscriptProjection,
  live: ReturnType<typeof liveMessageIdentity>,
): string | undefined {
  if (!live || live.timestamp === undefined) return undefined;
  const liveContent = messageContentKey(live.content);
  if (liveContent === undefined) return undefined;
  let matchedId: string | undefined;
  for (const item of Object.values(projection.items)) {
    if (
      item.kind !== 'message' ||
      item.messageId === live.messageId ||
      item.role !== live.role ||
      item.timestamp === undefined ||
      typeof item.timestamp !== typeof live.timestamp ||
      item.timestamp !== live.timestamp ||
      messageContentKey(item.content) !== liveContent
    )
      continue;
    // Ambiguous repeated messages must fail open. A visible duplicate is safer
    // than suppressing a distinct response that happens to serialize equally.
    if (matchedId !== undefined) return undefined;
    matchedId = item.messageId;
  }
  return matchedId;
}

function hasUserTranscriptMessage(projection: TranscriptProjection): boolean {
  return Object.values(projection.items).some(
    (item) => item.kind === 'message' && item.role === 'user',
  );
}

function withoutTranscriptMessage(
  projection: TranscriptProjection,
  messageId: string,
): TranscriptProjection {
  if (!projection.items[messageId]) return projection;
  const items = { ...projection.items };
  delete items[messageId];
  return {
    ...projection,
    items,
    order: projection.order.filter((id) => id !== messageId),
  };
}

function persistedLiveMessageIds(
  projection: TranscriptProjection,
  events: readonly DashboardEventEnvelope[],
): ReadonlySet<string> {
  const matched = new Set<string>();
  for (const envelope of events) {
    if (envelope.event.type !== 'message.finished') continue;
    const live = liveMessageIdentity(envelope);
    if (live && persistedMessageIdForLive(projection, live))
      matched.add(live.messageId);
  }
  return matched;
}

/**
 * The sole normalized live-state owner. It has no rendering or route logic;
 * React consumes it through useSyncExternalStore selectors.
 */
export class DashboardLiveStore {
  private state: DashboardLiveState = emptyState();
  private listeners = new Set<() => void>();
  private generation = 0;
  /** Runtime snapshots omit transport metadata; retain it outside the wire model. */
  private runtimeReducerStates = new Map<string, RuntimeReducerState>();
  private stream?: DashboardEventStream;
  private connectionAttempt = 0;
  private bootstrapReconnect?: () => void;
  private deferredNotification?: ReturnType<typeof setTimeout>;

  getGeneration(): number {
    return this.generation;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DashboardLiveState => this.state;

  private publish(next: DashboardLiveState, deferNotification = false): void {
    this.state = next;
    if (deferNotification) {
      if (this.deferredNotification !== undefined) return;
      this.deferredNotification = setTimeout(() => {
        this.deferredNotification = undefined;
        for (const listener of this.listeners) listener();
      }, LIVE_RENDER_INTERVAL_MS);
      return;
    }
    if (this.deferredNotification !== undefined) {
      clearTimeout(this.deferredNotification);
      this.deferredNotification = undefined;
    }
    for (const listener of this.listeners) listener();
  }

  /** Hydrate normalized entity maps and transport metadata from a wire snapshot. */
  private installSnapshotProjection(
    state: DashboardLiveState,
    snapshot: BrowserSnapshot,
  ): DashboardLiveState {
    return {
      ...state,
      serverId: snapshot.serverId,
      revision: snapshot.revision,
      snapshotCursor: snapshot.cursor,
      usage: snapshot.usage,
      projects: snapshot.projects,
      checkouts: snapshot.checkouts,
      threads: snapshot.threads,
      runs: snapshot.runs,
      workspacesById: indexed(snapshot.workspaces),
      workspaceOrder: snapshot.workspaces.map((item) => item.id),
      runtimesById: runtimeIndex(snapshot.runtimes),
      sessionsById: (() => {
        const sessions = indexed(snapshot.sessions);
        const optimistic = { ...state.optimisticSessionTitlesById };
        for (const session of snapshot.sessions) {
          if (
            session.name === undefined &&
            session.title === undefined &&
            optimistic[session.id] !== undefined
          ) {
            sessions[session.id] = {
              ...session,
              title: optimistic[session.id],
            };
          } else delete optimistic[session.id];
        }
        return sessions;
      })(),
      optimisticSessionTitlesById: (() => {
        const optimistic = { ...state.optimisticSessionTitlesById };
        for (const session of snapshot.sessions) {
          if (session.name !== undefined || session.title !== undefined)
            delete optimistic[session.id];
        }
        return optimistic;
      })(),
      notificationsById: indexed(snapshot.unread),
    };
  }

  private installRuntimeProjection(
    state: DashboardLiveState,
    runtime: RuntimeSnapshot,
  ): DashboardLiveState {
    return {
      ...state,
      runtimesById: { ...state.runtimesById, [runtime.runtimeId]: runtime },
    };
  }

  private installSessionProjection(
    state: DashboardLiveState,
    metadata: SessionIndexEntry,
  ): DashboardLiveState {
    return {
      ...state,
      sessionsById: { ...state.sessionsById, [metadata.id]: metadata },
    };
  }

  private installTranscriptProjection(
    state: DashboardLiveState,
    sessionId: string,
    projection: TranscriptProjection,
  ): DashboardLiveState {
    return {
      ...state,
      transcriptsBySessionId: {
        ...state.transcriptsBySessionId,
        [sessionId]: projection,
      },
    };
  }

  private removeNotificationProjection(
    state: DashboardLiveState,
    id: string,
  ): DashboardLiveState {
    const notificationsById = { ...state.notificationsById };
    delete notificationsById[id];
    return { ...state, notificationsById };
  }

  setConnection(status: ConnectionStatus, error?: string): void {
    const current = this.state.connection;
    if (
      current.status === status &&
      current.lastCursor === this.state.cursor &&
      current.error === error
    )
      return;
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
    if (this.state.usageError === error) return;
    this.publish({
      ...this.state,
      ...(error ? { usageError: error } : { usageError: undefined }),
    });
  }

  setError(error: string | undefined): void {
    if (this.state.connection.error === error) return;
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
      Math.max(this.state.cursor, this.state.snapshotCursor),
      next,
      {
        ...provenance,
        currentGeneration: this.generation,
      },
    );
    if (!decision.accepted) return false;
    if (decision.reset) {
      this.generation += 1;
      this.runtimeReducerStates.clear();
      const resetState = this.installSnapshotProjection(
        {
          ...emptyState(),
          cursor: next.cursor,
          connection: {
            ...this.state.connection,
            lastCursor: next.cursor,
          },
        },
        next,
      );
      this.publish({
        ...resetState,
        sessionChangeById: {},
        sessionReplacementByRuntimeId: {},
        sessionReplacementBySessionId: {},
        cursorHistory: [next.cursor].slice(-LIVE_BUFFER_LIMIT),
        resyncNonce: this.state.resyncNonce + 1,
      });
      return true;
    }
    if (this.state.snapshotCursor > next.cursor) return false;
    // Ordinary HTTP reads update the authoritative projection but must not
    // jump over SSE records that were requested earlier and are still being
    // replayed. Only SSE delivery (or an explicit replay-gap rebase) advances
    // the transport cursor.
    const advanceCursor =
      provenance.source !== 'http' || provenance.rebaseCursor === true;
    const cursor = advanceCursor ? next.cursor : this.state.cursor;
    const projected = this.installSnapshotProjection(this.state, next);
    this.publish({
      ...projected,
      cursor,
      connection: { ...projected.connection, lastCursor: cursor },
      cursorHistory: advanceCursor
        ? [...projected.cursorHistory, next.cursor].slice(-LIVE_BUFFER_LIMIT)
        : projected.cursorHistory,
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
      const projectionIsOlder =
        record.snapshot.serverId === this.state.serverId &&
        record.snapshot.cursor < this.state.snapshotCursor;
      if (!projectionIsOlder) {
        const accepted = this.installSnapshot(record.snapshot, {
          source: 'sse',
        });
        if (!accepted) return false;
      }
      if (record.cursor === this.state.cursor) return true;
      this.publish({
        ...this.state,
        cursor: record.cursor,
        connection: { ...this.state.connection, lastCursor: record.cursor },
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
    if (
      envelope.snapshot &&
      envelope.snapshot.serverId === this.state.serverId &&
      envelope.snapshot.cursor >= this.state.snapshotCursor
    )
      this.installSnapshot(envelope.snapshot, { source: 'sse' });
    let nextState = this.state;
    const sessionId = sessionIdForEvent(envelope);
    if (sessionId) {
      const currentProjection = nextState.transcriptsBySessionId[sessionId];
      const canSeedSnapshot =
        envelope.event.type === 'session.snapshot' &&
        (envelope.event.session as { entriesComplete?: boolean })
          .entriesComplete === true;
      const baseProjection =
        currentProjection ??
        (canSeedSnapshot ? hydrateTranscript([], sessionId) : undefined);
      if (baseProjection) {
        const liveMessage = liveMessageIdentity(envelope);
        const persistedMessageId =
          envelope.event.type === 'message.finished'
            ? persistedMessageIdForLive(baseProjection, liveMessage)
            : undefined;
        const nextProjection =
          persistedMessageId && liveMessage
            ? withoutTranscriptMessage(baseProjection, liveMessage.messageId)
            : reduceTranscriptEvent(baseProjection, envelope);
        if (nextProjection !== baseProjection)
          nextState = this.installTranscriptProjection(
            nextState,
            sessionId,
            nextProjection,
          );
      }
    }
    if (envelope.runtimeId) {
      const currentRuntime = nextState.runtimesById[envelope.runtimeId];
      if (currentRuntime) {
        const priorRuntimeState = this.runtimeReducerStates.get(
          envelope.runtimeId,
        );
        const runtimeState = priorRuntimeState
          ? { ...priorRuntimeState, snapshot: currentRuntime }
          : createRuntimeReducerState(currentRuntime);
        if (envelope.snapshot) {
          // The browser snapshot already includes this runtime event. Advance
          // transport metadata without reducing the event a second time.
          const ordering = applyTransportOrdering(runtimeState, envelope);
          this.runtimeReducerStates.set(envelope.runtimeId, {
            snapshot: currentRuntime,
            ...ordering.state,
          });
        } else {
          const reduced = applyRuntimeEvent(runtimeState, envelope);
          this.runtimeReducerStates.set(envelope.runtimeId, reduced.state);
          if (reduced.state.snapshot !== currentRuntime)
            nextState = this.installRuntimeProjection(
              nextState,
              reduced.state.snapshot,
            );
        }
      }
    }
    let sessionChangeById = nextState.sessionChangeById;
    let sessionReplacementByRuntimeId = nextState.sessionReplacementByRuntimeId;
    let sessionReplacementBySessionId = nextState.sessionReplacementBySessionId;
    const event = envelope.event;
    const semanticSessionUpdate =
      Boolean(sessionId) &&
      (event.type === 'message.finished' ||
        event.type === 'tool.finished' ||
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
      const current = nextState.sessionsById[sessionId];
      const hasAuthoritativeTitle =
        event.session.name !== undefined || event.session.title !== undefined;
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
        nextState = this.installSessionProjection(nextState, metadata);
      }
      if (hasAuthoritativeTitle) {
        const optimistic = { ...nextState.optimisticSessionTitlesById };
        delete optimistic[sessionId];
        nextState = {
          ...nextState,
          optimisticSessionTitlesById: optimistic,
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
    this.publish(
      {
        ...nextState,
        sessionChangeById,
        sessionReplacementByRuntimeId,
        sessionReplacementBySessionId,
        cursor: envelope.cursor,
        connection: { ...nextState.connection, lastCursor: envelope.cursor },
        cursorHistory: [...nextState.cursorHistory, envelope.cursor].slice(
          -LIVE_BUFFER_LIMIT,
        ),
        recentEvents: [...nextState.recentEvents, envelope].slice(
          -LIVE_BUFFER_LIMIT,
        ),
      },
      event.type === 'message.updated' || event.type === 'tool.updated',
    );
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
    // A session response can arrive while older records from the same SSE
    // replay are still pending. Its entries are authoritative, but transport
    // ordering is covered only through the cursor the stream has accepted.
    const coveredCursor = Math.min(snapshotCursor, this.state.cursor);
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
        ? coveredCursor
        : Math.min(coveredCursor, firstReplayCursor) - 1;
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
      // Persisted Pi messages are not guaranteed to carry explicit IDs. The
      // session API boundary assigns deterministic entry-index identities so
      // the canonical projection can render and reconcile them semantically.
      fallbackEntryIds: true,
      fallbackEntryOffset: response.history?.start ?? 0,
      cursor: replayCursor,
      ...(response.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: response.runtimeEpoch }),
      ...(baselineRuntimeSeq === undefined
        ? {}
        : { runtimeSeq: baselineRuntimeSeq }),
    });
    const canonicalLiveMessageIds = persistedLiveMessageIds(
      projection,
      sessionEvents,
    );
    for (const envelope of sessionEvents) {
      if (envelope.cursor <= projection.lastCursor) continue;
      const liveMessage = liveMessageIdentity(envelope);
      if (liveMessage && canonicalLiveMessageIds.has(liveMessage.messageId))
        continue;
      projection = reduceTranscriptEvent(projection, envelope);
    }
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
        coveredCursor,
        currentProjection?.lastCursor ?? -1,
      ),
      lastRuntimeSeq: Math.max(
        projection.lastRuntimeSeq,
        responseRuntimeSeq,
        currentRuntimeSeq,
      ),
      retiredEpochs: [...retiredEpochs],
    };
    const responseRuntimeMatches =
      response.runtimeEpoch === undefined ||
      response.runtimeEpoch === currentProjection?.runtimeEpoch;
    if (
      response.entriesComplete === false &&
      currentProjection &&
      responseRuntimeMatches
    ) {
      // A brand-new active session can beat both branch serialization and the
      // JSONL watcher. Keep an established user-visible branch authoritative.
      // If the optimistic baseline has no user message yet, however, merge the
      // later disk response behind its live tail; otherwise a refresh during
      // the first turn can permanently lose the initiating prompt.
      if (hasUserTranscriptMessage(currentProjection)) {
        projection = {
          ...currentProjection,
          lastCursor: Math.max(currentProjection.lastCursor, coveredCursor),
          lastRuntimeSeq: Math.max(
            currentProjection.lastRuntimeSeq,
            response.runtimeSeq ?? -1,
          ),
          retiredEpochs: [...retiredEpochs],
        };
      } else {
        const merged = mergePrependedTranscript(currentProjection, projection);
        projection = {
          ...projection,
          order: merged.order,
          items: merged.items,
        };
      }
    }
    const currentMetadata = this.state.sessionsById[response.metadata.id];
    const optimisticTitle =
      this.state.optimisticSessionTitlesById[response.metadata.id];
    const metadata = {
      ...response.metadata,
      ...(response.metadata.name === undefined && currentMetadata?.name
        ? { name: currentMetadata.name }
        : {}),
      ...(response.metadata.title === undefined
        ? optimisticTitle !== undefined
          ? { title: optimisticTitle }
          : currentMetadata?.title !== undefined
            ? { title: currentMetadata.title }
            : {}
        : {}),
    };
    let nextState = this.installSessionProjection(this.state, metadata);
    if (
      response.metadata.name !== undefined ||
      response.metadata.title !== undefined
    ) {
      const optimistic = { ...nextState.optimisticSessionTitlesById };
      delete optimistic[response.metadata.id];
      nextState = {
        ...nextState,
        optimisticSessionTitlesById: optimistic,
      };
    }
    nextState = this.installTranscriptProjection(
      nextState,
      response.metadata.id,
      projection,
    );
    this.publish(nextState);
    return projection;
  }

  /** Prepend a bounded disk page without replacing the live transcript baseline. */
  prependSessionHistory(
    response: SessionApiResponse,
  ): TranscriptProjection | undefined {
    if (!response.history) return undefined;
    if (
      response.serverId !== undefined &&
      this.state.serverId !== undefined &&
      response.serverId !== this.state.serverId
    )
      return undefined;
    const sessionId = response.metadata.id;
    const current = this.state.transcriptsBySessionId[sessionId];
    if (!current) return undefined;
    const older = hydrateTranscript(response.entries, sessionId, {
      fallbackEntryIds: true,
      fallbackEntryOffset: response.history.start,
    });
    const projection = mergePrependedTranscript(current, older);
    const currentMetadata = this.state.sessionsById[sessionId];
    const optimisticTitle = this.state.optimisticSessionTitlesById[sessionId];
    const metadata = {
      ...response.metadata,
      ...(response.metadata.name === undefined && currentMetadata?.name
        ? { name: currentMetadata.name }
        : {}),
      ...(response.metadata.title === undefined
        ? optimisticTitle !== undefined
          ? { title: optimisticTitle }
          : currentMetadata?.title !== undefined
            ? { title: currentMetadata.title }
            : {}
        : {}),
    };
    let nextState = this.installSessionProjection(this.state, metadata);
    if (
      response.metadata.name !== undefined ||
      response.metadata.title !== undefined
    ) {
      const optimistic = { ...nextState.optimisticSessionTitlesById };
      delete optimistic[sessionId];
      nextState = {
        ...nextState,
        optimisticSessionTitlesById: optimistic,
      };
    }
    nextState = this.installTranscriptProjection(
      nextState,
      sessionId,
      projection,
    );
    this.publish(nextState);
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
    if (!this.state.serverId) return;
    this.publish({ ...this.state, usage });
  }

  updateSessionMetadata(
    id: string,
    patch: Pick<SessionIndexEntry, 'name' | 'title'>,
  ): void {
    const current = this.state.sessionsById[id];
    if (!current) return;
    const metadata = { ...current, ...patch };
    let nextState = this.installSessionProjection(this.state, metadata);
    if (patch.name !== undefined || patch.title !== undefined) {
      const optimistic = { ...nextState.optimisticSessionTitlesById };
      delete optimistic[id];
      nextState = { ...nextState, optimisticSessionTitlesById: optimistic };
    }
    this.publish(nextState);
  }

  /** Render the first prompt title before the runtime reaches settlement. */
  optimisticallyTitleSession(id: string, prompt: string): boolean {
    const current = this.state.sessionsById[id];
    if (!current || current.name !== undefined || current.title !== undefined)
      return false;
    const projection = this.state.transcriptsBySessionId[id];
    if (
      projection &&
      Object.values(projection.items).some(
        (item) => item.kind === 'message' && item.role === 'user',
      )
    )
      return false;
    const title = deriveSessionTitle([
      { type: 'message', message: { role: 'user', content: prompt } },
    ]);
    if (!title) return false;
    this.publish({
      ...this.state,
      sessionsById: {
        ...this.state.sessionsById,
        [id]: { ...current, title },
      },
      optimisticSessionTitlesById: {
        ...this.state.optimisticSessionTitlesById,
        [id]: title,
      },
    });
    return true;
  }

  markNotificationRead(id: string): void {
    const current = this.state.notificationsById[id];
    if (!current) return;
    this.publish(this.removeNotificationProjection(this.state, id));
  }

  clearServer(): void {
    this.generation += 1;
    this.publish(emptyState());
  }

  connect(client: DashboardHttpClient): () => void {
    this.stream?.stop();
    this.stream = undefined;
    this.bootstrapReconnect = undefined;
    const attempt = ++this.connectionAttempt;
    let stopped = false;
    let eventStream: DashboardEventStream | undefined;
    let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
    let bootstrapDelay = BOOTSTRAP_RETRY_MIN_MS;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (bootstrapTimer !== undefined) clearTimeout(bootstrapTimer);
      if (this.connectionAttempt !== attempt) return;
      this.connectionAttempt += 1;
      eventStream?.stop();
      if (this.stream === eventStream) this.stream = undefined;
      if (this.bootstrapReconnect === reconnectBootstrap)
        this.bootstrapReconnect = undefined;
    };
    const scheduleBootstrap = () => {
      if (stopped || this.connectionAttempt !== attempt) return;
      if (bootstrapTimer !== undefined) clearTimeout(bootstrapTimer);
      bootstrapTimer = setTimeout(() => {
        bootstrapTimer = undefined;
        void bootstrap();
      }, bootstrapDelay);
      bootstrapDelay = Math.min(BOOTSTRAP_RETRY_MAX_MS, bootstrapDelay * 2);
    };
    const reconnectBootstrap = () => {
      if (stopped || eventStream) return;
      if (bootstrapTimer !== undefined) clearTimeout(bootstrapTimer);
      bootstrapTimer = undefined;
      bootstrapDelay = BOOTSTRAP_RETRY_MIN_MS;
      void bootstrap();
    };
    const bootstrap = async () => {
      if (stopped || this.connectionAttempt !== attempt || eventStream) return;
      const requestGeneration = this.generation;
      try {
        const snapshot = await client.snapshot();
        if (stopped || this.connectionAttempt !== attempt || eventStream)
          return;
        const priorTransportCursor =
          this.state.serverId === snapshot.serverId ? this.state.cursor : 0;
        if (
          !this.installSnapshot(snapshot, {
            source: 'http',
            requestGeneration,
          })
        )
          throw new Error('Dashboard bootstrap snapshot was not accepted.');
        // Browser snapshots intentionally omit transcript entries. Replay a
        // bounded live overlap so a terminal message published at the HTTP
        // snapshot cursor still reaches transcript reconciliation.
        const replayCursor = Math.max(
          priorTransportCursor,
          snapshot.cursor - INITIAL_REPLAY_OVERLAP,
          0,
        );
        this.publish({
          ...this.state,
          cursor: replayCursor,
          connection: {
            ...this.state.connection,
            lastCursor: replayCursor,
          },
          cursorHistory: [replayCursor],
        });
        if (stopped || this.connectionAttempt !== attempt) return;
        bootstrapDelay = BOOTSTRAP_RETRY_MIN_MS;
        eventStream = new DashboardEventStream({
          client,
          getCursor: () => this.state.cursor,
          getServerId: () => this.state.serverId,
          onRecord: (record) => {
            this.acceptStreamRecord(record);
          },
          onReplayGap: async () => {
            const resyncGeneration = this.generation;
            if (this.stream !== eventStream) return;
            try {
              const next = await client.snapshot();
              if (this.stream !== eventStream) return;
              const accepted = this.installSnapshot(next, {
                source: 'http',
                requestGeneration: resyncGeneration,
                rebaseCursor: true,
              });
              if (!accepted)
                throw new Error('Dashboard resync snapshot was not accepted.');
              this.publish({
                ...this.state,
                resyncNonce: this.state.resyncNonce + 1,
              });
            } catch (cause) {
              this.setError(
                cause instanceof Error ? cause.message : String(cause),
              );
              // A failed rebase must reach the reconnect loop so its existing
              // exponential delay is retained instead of being reset.
              throw cause;
            }
          },
          onState: (status) => this.setConnection(status),
          onError: (error) => this.setError(error?.message),
        });
        this.stream = eventStream;
        this.bootstrapReconnect = undefined;
        eventStream.start();
      } catch (cause) {
        if (stopped || this.connectionAttempt !== attempt || eventStream)
          return;
        this.setError(cause instanceof Error ? cause.message : String(cause));
        scheduleBootstrap();
      }
    };
    this.bootstrapReconnect = reconnectBootstrap;
    void bootstrap();
    return stop;
  }

  reconnect(): void {
    if (this.stream) this.stream.reconnect();
    else this.bootstrapReconnect?.();
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

let lastMaterializedParts:
  | Pick<
      DashboardLiveState,
      | 'serverId'
      | 'revision'
      | 'snapshotCursor'
      | 'usage'
      | 'projects'
      | 'checkouts'
      | 'threads'
      | 'runs'
      | 'workspacesById'
      | 'workspaceOrder'
      | 'runtimesById'
      | 'sessionsById'
      | 'notificationsById'
    >
  | undefined;
let lastMaterializedSnapshot: BrowserSnapshot | undefined;

/** Materialize the legacy wire shape only for shell/route consumers. */
export function materializeSnapshot(
  state: DashboardLiveState,
): BrowserSnapshot | undefined {
  if (!state.serverId) return undefined;
  const parts = {
    serverId: state.serverId,
    revision: state.revision,
    snapshotCursor: state.snapshotCursor,
    usage: state.usage,
    projects: state.projects,
    checkouts: state.checkouts,
    threads: state.threads,
    runs: state.runs,
    workspacesById: state.workspacesById,
    workspaceOrder: state.workspaceOrder,
    runtimesById: state.runtimesById,
    sessionsById: state.sessionsById,
    notificationsById: state.notificationsById,
  };
  const previousParts = lastMaterializedParts;
  if (
    previousParts &&
    Object.keys(parts).every(
      (key) =>
        parts[key as keyof typeof parts] ===
        previousParts[key as keyof typeof previousParts],
    )
  )
    return lastMaterializedSnapshot;
  const snapshot: BrowserSnapshot = {
    serverId: state.serverId,
    revision: state.revision,
    cursor: state.snapshotCursor,
    runtimes: Object.values(state.runtimesById),
    workspaces: state.workspaceOrder.flatMap((id) => {
      const workspace = state.workspacesById[id];
      return workspace ? [workspace] : [];
    }),
    sessions: Object.values(state.sessionsById),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    ...(state.projects === undefined ? {} : { projects: state.projects }),
    ...(state.checkouts === undefined ? {} : { checkouts: state.checkouts }),
    ...(state.threads === undefined ? {} : { threads: state.threads }),
    ...(state.runs === undefined ? {} : { runs: state.runs }),
    unread: Object.values(state.notificationsById),
  };
  lastMaterializedParts = parts;
  lastMaterializedSnapshot = snapshot;
  return snapshot;
}

export const selectSnapshot = materializeSnapshot;
const EMPTY_PROJECTS: readonly ProjectSummary[] = [];
const EMPTY_CHECKOUTS: readonly CheckoutSummary[] = [];
const EMPTY_THREADS: readonly ThreadSummary[] = [];
const EMPTY_RUNS: readonly RunSummary[] = [];
const EMPTY_WORKSPACES: readonly WorkspaceTarget[] = [];
const EMPTY_RUNTIMES: readonly RuntimeSnapshot[] = [];
const EMPTY_SESSIONS: readonly SessionIndexEntry[] = [];
const EMPTY_NOTIFICATIONS: readonly BrowserSnapshot['unread'][number][] = [];
export const selectProjects = (state: DashboardLiveState) =>
  state.projects ?? EMPTY_PROJECTS;
export const selectCheckouts = (state: DashboardLiveState) =>
  state.checkouts ?? EMPTY_CHECKOUTS;
export const selectThreads = (state: DashboardLiveState) =>
  state.threads ?? EMPTY_THREADS;
export const selectRuns = (state: DashboardLiveState) =>
  state.runs ?? EMPTY_RUNS;
export const selectWorkspaces = (state: DashboardLiveState) =>
  materializeSnapshot(state)?.workspaces ?? EMPTY_WORKSPACES;
export const selectRuntimes = (state: DashboardLiveState) =>
  materializeSnapshot(state)?.runtimes ?? EMPTY_RUNTIMES;
export const selectSessions = (state: DashboardLiveState) =>
  materializeSnapshot(state)?.sessions ?? EMPTY_SESSIONS;
export const selectNotifications = (state: DashboardLiveState) =>
  materializeSnapshot(state)?.unread ?? EMPTY_NOTIFICATIONS;
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
export const selectRuntimeForSession =
  (sessionId: string) => (state: DashboardLiveState) =>
    Object.values(state.runtimesById).find(
      (runtime) => runtime.session.id === sessionId,
    );
