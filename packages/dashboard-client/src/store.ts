import {
  applyRuntimeEvent,
  createRuntimeReducerState,
  hydrateTranscript,
  type RuntimeReducerState,
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

function upsertEntity<T>(
  items: readonly T[],
  next: T,
  getId: (item: T) => string,
): readonly T[] {
  const id = getId(next);
  let replaced = false;
  const result = items.map((item) => {
    if (getId(item) !== id) return item;
    replaced = true;
    return next;
  });
  return replaced ? result : [...result, next];
}

function removeEntity<T>(
  items: readonly T[],
  id: string,
  getId: (item: T) => string,
): readonly T[] {
  return items.filter((item) => getId(item) !== id);
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
  /** Runtime snapshots omit transport metadata; retain it outside the wire model. */
  private runtimeReducerStates = new Map<string, RuntimeReducerState>();
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

  /** Install every entity index represented by an authoritative browser snapshot. */
  private installSnapshotProjection(
    state: DashboardLiveState,
    snapshot: BrowserSnapshot,
  ): DashboardLiveState {
    return {
      ...state,
      snapshot,
      serverId: snapshot.serverId,
      revision: snapshot.revision,
      workspacesById: indexed(snapshot.workspaces),
      workspaceOrder: snapshot.workspaces.map((item) => item.id),
      runtimesById: runtimeIndex(snapshot.runtimes),
      sessionsById: indexed(snapshot.sessions),
      notificationsById: indexed(snapshot.unread),
    };
  }

  /** Keep the runtime index and embedded browser snapshot projection in lockstep. */
  private installRuntimeProjection(
    state: DashboardLiveState,
    runtime: RuntimeSnapshot,
  ): DashboardLiveState {
    return {
      ...state,
      runtimesById: { ...state.runtimesById, [runtime.runtimeId]: runtime },
      snapshot: state.snapshot
        ? {
            ...state.snapshot,
            runtimes: upsertEntity(
              state.snapshot.runtimes,
              runtime,
              (item) => item.runtimeId,
            ),
          }
        : undefined,
    };
  }

  /** Keep session metadata in both the index and embedded browser snapshot. */
  private installSessionProjection(
    state: DashboardLiveState,
    metadata: SessionIndexEntry,
  ): DashboardLiveState {
    return {
      ...state,
      sessionsById: { ...state.sessionsById, [metadata.id]: metadata },
      snapshot: state.snapshot
        ? {
            ...state.snapshot,
            sessions: upsertEntity(
              state.snapshot.sessions,
              metadata,
              (item) => item.id,
            ),
          }
        : undefined,
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
    return {
      ...state,
      notificationsById,
      snapshot: state.snapshot
        ? {
            ...state.snapshot,
            unread: removeEntity(state.snapshot.unread, id, (item) => item.id),
          }
        : undefined,
    };
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
      Math.max(this.state.cursor, this.state.snapshot?.cursor ?? 0),
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
    const current = this.state.snapshot;
    if (current && current.cursor > next.cursor) return false;
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
        record.snapshot.cursor < (this.state.snapshot?.cursor ?? 0);
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
      envelope.snapshot.cursor >= (this.state.snapshot?.cursor ?? 0)
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
        const nextProjection = reduceTranscriptEvent(baseProjection, envelope);
        if (nextProjection !== baseProjection)
          nextState = this.installTranscriptProjection(
            nextState,
            sessionId,
            nextProjection,
          );
      }
    }
    if (!envelope.snapshot && envelope.runtimeId) {
      const currentRuntime = nextState.runtimesById[envelope.runtimeId];
      if (currentRuntime) {
        const priorRuntimeState = this.runtimeReducerStates.get(
          envelope.runtimeId,
        );
        const runtimeState = priorRuntimeState
          ? { ...priorRuntimeState, snapshot: currentRuntime }
          : createRuntimeReducerState(currentRuntime);
        const reduced = applyRuntimeEvent(runtimeState, envelope);
        this.runtimeReducerStates.set(envelope.runtimeId, reduced.state);
        if (reduced.state.snapshot !== currentRuntime)
          nextState = this.installRuntimeProjection(
            nextState,
            reduced.state.snapshot,
          );
      }
    }
    let sessionChangeById = nextState.sessionChangeById;
    let sessionReplacementByRuntimeId = nextState.sessionReplacementByRuntimeId;
    let sessionReplacementBySessionId = nextState.sessionReplacementBySessionId;
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
      const current = nextState.sessionsById[sessionId];
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
    const sameRuntimeGeneration =
      currentProjection !== undefined &&
      (currentProjection.runtimeEpoch === undefined ||
        response.runtimeEpoch === undefined ||
        currentProjection.runtimeEpoch === response.runtimeEpoch);
    if (currentProjection && sameRuntimeGeneration) {
      // A delayed/equal-generation HTTP read is not allowed to replace an
      // already-live projection: the event that established its branch may
      // have aged out of the bounded replay tail. HTTP can enrich transport
      // metadata, while a genuinely new runtime epoch still rehydrates.
      projection = {
        ...currentProjection,
        ...(currentProjection.runtimeEpoch === undefined &&
        response.runtimeEpoch !== undefined
          ? { runtimeEpoch: response.runtimeEpoch }
          : {}),
        lastCursor: Math.max(currentProjection.lastCursor, coveredCursor),
        lastRuntimeSeq: Math.max(
          currentProjection.lastRuntimeSeq,
          response.runtimeSeq ?? -1,
        ),
        retiredEpochs: [...retiredEpochs],
      };
    }
    const currentMetadata = this.state.sessionsById[response.metadata.id];
    const metadata = currentMetadata
      ? { ...response.metadata, ...currentMetadata }
      : response.metadata;
    let nextState = this.installSessionProjection(this.state, metadata);
    nextState = this.installTranscriptProjection(
      nextState,
      response.metadata.id,
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
    this.publish(this.installSessionProjection(this.state, metadata));
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
    this.stream = new DashboardEventStream({
      client,
      getCursor: () => this.state.cursor,
      getServerId: () => this.state.serverId,
      onRecord: (record) => {
        this.acceptStreamRecord(record);
      },
      onReplayGap: async () => {
        const requestGeneration = this.generation;
        try {
          const snapshot = await client.snapshot();
          this.installSnapshot(snapshot, {
            source: 'http',
            requestGeneration,
            currentGeneration: this.generation,
            rebaseCursor: true,
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
