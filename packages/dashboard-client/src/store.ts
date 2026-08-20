import {
  applyRuntimeEvent,
  applyTransportOrdering,
  createRuntimeReducerState,
  hydrateTranscript,
  type RuntimeReducerState,
  type TranscriptProjection,
} from '@pi-dashboard/domain';
import {
  type AuthoritativeSessionSnapshot,
  type BrowserSnapshot,
  type CheckoutSummary,
  type DashboardEventEnvelope,
  deriveSessionTitle,
  type ProjectSummary,
  type RunSummary,
  type RuntimeSnapshot,
  type SessionIndexEntry,
  type ShellFeedEvent,
  type ShellProjection,
  type ShellRuntimeSnapshot,
  type ThreadSummary,
  tryParseAuthoritativeSessionSnapshot,
  type WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { useSyncExternalStore } from 'react';
import { DashboardConnectionRuntime } from './connection-runtime.js';
import type { DashboardHttpClient } from './http-client.js';
import {
  type ClientAuthoritativeSessionSnapshot,
  SESSION_REQUEST_ORDER,
} from './http-client.js';
import {
  acceptTranscriptEventOrdering,
  acceptTranscriptSnapshotOrdering,
  coverageWithPages as buildHistoryCoverage,
  classifyHistoryPageWatermark,
  historyFromPages,
  installAuthoritativeTranscript,
  liveMessageIdentity,
  mergePrependedTranscript,
  newestProjection,
  reduceSessionTranscriptEvent,
  SESSION_HISTORY_BUDGET,
  type SessionHistoryCoverage,
  type SessionHistoryPageCoverage,
  pageCoverage as transcriptPageCoverage,
} from './session-transcript-state.js';

export type {
  SessionHistoryCoverage,
  SessionHistoryPageCoverage,
} from './session-transcript-state.js';
export { SESSION_HISTORY_BUDGET } from './session-transcript-state.js';

export const LIVE_RENDER_INTERVAL_MS = 32;

export type ConnectionStatus =
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'blocked'
  | 'error';
export type SyncStatus =
  | 'empty'
  | 'cached'
  | 'synchronizing'
  | 'live'
  | 'error';
export interface DomainSyncState {
  status: SyncStatus;
  generation: number;
  sequence: number;
  sequenceKnown: boolean;
  error?: string;
}

export interface DashboardLiveState {
  /** Transport metadata is retained separately from hydrated entities. */
  serverId?: string;
  revision: number;
  snapshotCursor: number;
  /** Whether the shell catalogue is a complete authoritative projection. */
  shellProjection?: ShellProjection;
  usage?: unknown;
  projects?: readonly ProjectSummary[];
  checkouts?: readonly CheckoutSummary[];
  threads?: readonly ThreadSummary[];
  runs?: readonly RunSummary[];
  cursor: number;
  connection: {
    status: ConnectionStatus;
    /** Compatibility diagnostic; live domains use their own sequence values. */
    lastCursor: number;
    error?: string;
    errorKind?: import('./http-client.js').DashboardHttpErrorKind;
  };
  shellSync: DomainSyncState;
  sessionSyncById: Readonly<Record<string, DomainSyncState>>;
  /** Latest authoritative response delivered by an acquired session feed. */
  sessionSnapshotsById: Readonly<Record<string, AuthoritativeSessionSnapshot>>;
  /** Verified, contiguous disk-history coverage owned by the store. */
  sessionHistoryCoverageById: Readonly<Record<string, SessionHistoryCoverage>>;
  workspacesById: Readonly<Record<string, WorkspaceTarget>>;
  workspaceOrder: readonly string[];
  runtimesById: Readonly<Record<string, RuntimeSnapshot>>;
  sessionsById: Readonly<Record<string, SessionIndexEntry>>;
  /** First-turn titles are rendered before Pi persists or publishes session metadata. */
  optimisticSessionTitlesById: Readonly<Record<string, string>>;
  /** New-runtime prompts are retained until the runtime publishes its session id. */
  optimisticRuntimeTitlesById: Readonly<Record<string, string>>;
  /** Monotonic semantic updates used by transcript views; pages do not consume raw envelopes. */
  sessionChangeById: Readonly<Record<string, number>>;
  sessionReplacementByRuntimeId: Readonly<Record<string, string>>;
  sessionReplacementBySessionId: Readonly<Record<string, string>>;
  notificationsById: Readonly<
    Record<string, BrowserSnapshot['unread'][number]>
  >;
  transcriptsBySessionId: Readonly<Record<string, TranscriptProjection>>;
  usageError?: string;
}

export interface SnapshotAcceptanceProvenance {
  source?: 'http' | 'sse';
  requestGeneration?: number;
  currentGeneration?: number;
  /** A replay-gap or daemon-restart snapshot establishes a new domain baseline. */
  rebaseCursor?: boolean;
  /** Accept a same-generation authoritative feed snapshot below local cursor. */
  authoritativeRebase?: boolean;
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
  if (provenance.authoritativeRebase === true)
    return { accepted: true, reset: false };
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
    snapshotCursor: 0,
    cursor: 0,
    connection: { status: 'offline', lastCursor: 0 },
    shellSync: {
      status: 'empty',
      generation: 0,
      sequence: 0,
      sequenceKnown: false,
    },
    sessionSyncById: {},
    sessionSnapshotsById: {},
    sessionHistoryCoverageById: {},
    workspacesById: {},
    workspaceOrder: [],
    runtimesById: {},
    sessionsById: {},
    optimisticSessionTitlesById: {},
    optimisticRuntimeTitlesById: {},
    sessionChangeById: {},
    sessionReplacementByRuntimeId: {},
    sessionReplacementBySessionId: {},
    notificationsById: {},
    transcriptsBySessionId: {},
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

function withOptimisticSessionTitle(
  state: DashboardLiveState,
  id: string,
  content: unknown,
): DashboardLiveState {
  const current = state.sessionsById[id];
  if (current?.name !== undefined || current?.title !== undefined) return state;
  const title = deriveSessionTitle([
    { type: 'message', message: { role: 'user', content } },
  ]);
  if (!title) return state;
  const runtimesById = { ...state.runtimesById };
  let matchedRuntime = false;
  for (const [runtimeId, runtime] of Object.entries(runtimesById)) {
    if (runtime.session.id !== id) continue;
    matchedRuntime = true;
    if (
      runtime.session.name !== undefined ||
      runtime.session.title !== undefined
    )
      return state;
    runtimesById[runtimeId] = {
      ...runtime,
      session: { ...runtime.session, title },
    };
  }
  if (!current && !matchedRuntime) return state;
  return {
    ...state,
    runtimesById,
    ...(current
      ? {
          sessionsById: {
            ...state.sessionsById,
            [id]: { ...current, title },
          },
        }
      : {}),
    optimisticSessionTitlesById: {
      ...state.optimisticSessionTitlesById,
      [id]: title,
    },
  };
}

interface PendingSessionHistory {
  responses: readonly AuthoritativeSessionSnapshot[];
  expectedSessionId: string;
  generation: number;
  sequence: number;
}

/**
 * The sole normalized live-state owner. It has no rendering or route logic;
 * React consumes it through useSyncExternalStore selectors.
 */
export class DashboardLiveStore {
  private state: DashboardLiveState = emptyState();
  private listeners = new Set<() => void>();
  private generation = 0;
  /** Latest reads are ordered per session; historical pages are intentionally excluded. */
  private latestSessionRequestOrders = new Map<string, number>();
  /** Runtime snapshots omit transport metadata; retain it outside the wire model. */
  private runtimeReducerStates = new Map<string, RuntimeReducerState>();
  /** Older pages wait behind their exact session-feed cut, never timestamps. */
  private pendingSessionHistory = new Map<string, PendingSessionHistory>();
  private connectionRuntime?: DashboardConnectionRuntime;
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
    const optimisticSessions = { ...state.optimisticSessionTitlesById };
    const optimisticRuntimes = { ...state.optimisticRuntimeTitlesById };
    for (const runtime of snapshot.runtimes) {
      const pendingTitle = optimisticRuntimes[runtime.runtimeId];
      if (pendingTitle === undefined) continue;
      delete optimisticRuntimes[runtime.runtimeId];
      optimisticSessions[runtime.session.id] = pendingTitle;
    }
    const sessions = indexed(snapshot.sessions);
    for (const session of snapshot.sessions) {
      const title = optimisticSessions[session.id];
      if (
        session.name === undefined &&
        session.title === undefined &&
        title !== undefined
      )
        sessions[session.id] = { ...session, title };
      else delete optimisticSessions[session.id];
    }
    const runtimes = snapshot.runtimes.map((runtime) => {
      const metadata = sessions[runtime.session.id];
      const optimisticTitle = optimisticSessions[runtime.session.id];
      const metadataTitleIsOptimistic =
        metadata?.title !== undefined && metadata.title === optimisticTitle;
      const pendingTitle = optimisticRuntimes[runtime.runtimeId];
      const title = metadata?.title ?? pendingTitle ?? optimisticTitle;
      if (pendingTitle !== undefined) {
        delete optimisticRuntimes[runtime.runtimeId];
        optimisticSessions[runtime.session.id] = pendingTitle;
      }
      if (metadata?.name !== undefined || runtime.session.name !== undefined) {
        delete optimisticSessions[runtime.session.id];
        return {
          ...runtime,
          session: {
            ...runtime.session,
            name: metadata?.name ?? runtime.session.name,
            ...(title === undefined ? {} : { title }),
          },
        };
      }
      if (metadata?.title !== undefined && !metadataTitleIsOptimistic) {
        delete optimisticSessions[runtime.session.id];
        return { ...runtime, session: { ...runtime.session, title } };
      }
      if (runtime.session.title !== undefined) {
        delete optimisticSessions[runtime.session.id];
        return runtime;
      }
      return title === undefined
        ? runtime
        : { ...runtime, session: { ...runtime.session, title } };
    });
    return {
      ...state,
      serverId: snapshot.serverId,
      revision: snapshot.revision,
      snapshotCursor: snapshot.cursor,
      shellProjection: snapshot.shellProjection,
      usage: snapshot.usage,
      projects: snapshot.projects,
      checkouts: snapshot.checkouts,
      threads: snapshot.threads,
      runs: snapshot.runs,
      workspacesById: indexed(snapshot.workspaces),
      workspaceOrder: snapshot.workspaces.map((item) => item.id),
      runtimesById: runtimeIndex(runtimes),
      sessionsById: sessions,
      optimisticSessionTitlesById: optimisticSessions,
      optimisticRuntimeTitlesById: optimisticRuntimes,
      notificationsById: indexed(snapshot.unread),
    };
  }

  private installRuntimeProjection(
    state: DashboardLiveState,
    runtime: RuntimeSnapshot,
  ): DashboardLiveState {
    const optimisticRuntimes = { ...state.optimisticRuntimeTitlesById };
    const optimisticSessions = { ...state.optimisticSessionTitlesById };
    const metadata = state.sessionsById[runtime.session.id];
    const optimisticTitle = optimisticSessions[runtime.session.id];
    const metadataTitleIsOptimistic =
      metadata?.title !== undefined && metadata.title === optimisticTitle;
    const pendingTitle = optimisticRuntimes[runtime.runtimeId];
    const title = metadata?.title ?? pendingTitle ?? optimisticTitle;
    if (pendingTitle !== undefined) {
      delete optimisticRuntimes[runtime.runtimeId];
      optimisticSessions[runtime.session.id] = pendingTitle;
    }
    const authoritativeName = metadata?.name ?? runtime.session.name;
    const hasAuthoritativeTitle =
      authoritativeName !== undefined ||
      (metadata?.title !== undefined && !metadataTitleIsOptimistic) ||
      (runtime.session.title !== undefined && runtime.session.title !== title);
    if (hasAuthoritativeTitle) delete optimisticSessions[runtime.session.id];
    const projectedRuntime = {
      ...runtime,
      session: {
        ...runtime.session,
        ...(authoritativeName === undefined ? {} : { name: authoritativeName }),
        ...(title === undefined ? {} : { title }),
      },
    };
    return {
      ...state,
      runtimesById: {
        ...state.runtimesById,
        [runtime.runtimeId]: projectedRuntime,
      },
      optimisticSessionTitlesById: optimisticSessions,
      optimisticRuntimeTitlesById: optimisticRuntimes,
    };
  }

  private installSessionReplacementProjection(
    state: DashboardLiveState,
    sessions: readonly SessionIndexEntry[],
  ): DashboardLiveState {
    let nextState: DashboardLiveState = {
      ...state,
      sessionsById: indexed(sessions),
    };
    for (const runtime of Object.values(nextState.runtimesById)) {
      const metadata = nextState.sessionsById[runtime.session.id];
      const session = { ...runtime.session };
      // The replacement is authoritative for overlays. Remove fields that
      // disappeared instead of retaining stale values from the old index.
      delete session.name;
      delete session.title;
      if (metadata?.name !== undefined) session.name = metadata.name;
      if (metadata?.title !== undefined) session.title = metadata.title;
      nextState = this.installRuntimeProjection(nextState, {
        ...runtime,
        session,
      });
    }
    return nextState;
  }

  private installSessionProjection(
    state: DashboardLiveState,
    metadata: SessionIndexEntry,
  ): DashboardLiveState {
    const runtimesById = { ...state.runtimesById };
    for (const [runtimeId, runtime] of Object.entries(runtimesById)) {
      if (runtime.session.id !== metadata.id) continue;
      runtimesById[runtimeId] = {
        ...runtime,
        session: {
          ...runtime.session,
          ...(metadata.name === undefined ? {} : { name: metadata.name }),
          ...(metadata.title === undefined ? {} : { title: metadata.title }),
        },
      };
    }
    return {
      ...state,
      runtimesById,
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

  private pageCoverage(
    response: AuthoritativeSessionSnapshot,
  ): SessionHistoryPageCoverage | undefined {
    return transcriptPageCoverage(response);
  }

  private coverageWithPages(
    pages: readonly SessionHistoryPageCoverage[],
    serverId: string | undefined,
    runtimeEpoch: string | undefined,
  ): SessionHistoryCoverage | undefined {
    return buildHistoryCoverage(pages, this.generation, serverId, runtimeEpoch);
  }

  private withCoverage(
    state: DashboardLiveState,
    sessionId: string,
    coverage: SessionHistoryCoverage | undefined,
  ): DashboardLiveState {
    const sessionHistoryCoverageById = {
      ...state.sessionHistoryCoverageById,
    };
    if (coverage) sessionHistoryCoverageById[sessionId] = coverage;
    else delete sessionHistoryCoverageById[sessionId];
    const snapshot = state.sessionSnapshotsById[sessionId];
    const newestPage = coverage?.pages.at(-1);
    return {
      ...state,
      sessionHistoryCoverageById,
      ...(coverage && snapshot && newestPage
        ? {
            sessionSnapshotsById: {
              ...state.sessionSnapshotsById,
              [sessionId]: {
                ...snapshot,
                // Keep the wire snapshot's newest-window semantics. The
                // aggregate covered range is exposed by the coverage selector.
                history: historyFromPages([newestPage]),
              },
            },
          }
        : {}),
    };
  }

  private clearHistoryCoverage(sessionId: string): void {
    if (!this.state.sessionHistoryCoverageById[sessionId]) return;
    this.publish(this.withCoverage(this.state, sessionId, undefined));
  }

  /** Fail closed to the newest authoritative window for an expected session. */
  resetSessionHistoryToNewest(sessionId: string): void {
    this.pendingSessionHistory.delete(sessionId);
    const coverage = this.state.sessionHistoryCoverageById[sessionId];
    const current = this.state.transcriptsBySessionId[sessionId];
    if (!coverage || !current) {
      this.clearHistoryCoverage(sessionId);
      return;
    }
    this.publish(this.resetCoverageToNewest(sessionId, current, coverage));
  }

  private flushPendingSessionHistory(sessionId: string): void {
    const pending = this.pendingSessionHistory.get(sessionId);
    if (!pending) return;
    const sync = this.state.sessionSyncById[sessionId];
    if (!sync?.sequenceKnown || sync.sequence < pending.sequence) return;
    this.pendingSessionHistory.delete(sessionId);
    if (
      sync.generation !== pending.generation ||
      sync.sequence !== pending.sequence
    ) {
      this.resetSessionHistoryToNewest(sessionId);
      return;
    }
    this.prependSessionHistoryPages(
      pending.responses,
      pending.expectedSessionId,
    );
  }

  private resetCoverageToNewest(
    sessionId: string,
    current: TranscriptProjection | undefined,
    coverage: SessionHistoryCoverage | undefined,
  ): DashboardLiveState {
    if (!current || !coverage)
      return this.withCoverage(this.state, sessionId, undefined);
    const newest = newestProjection(current, coverage);
    const newestPage = coverage.pages.at(-1);
    const nextCoverage = newestPage
      ? this.coverageWithPages(
          [newestPage],
          coverage.serverId,
          coverage.runtimeEpoch,
        )
      : undefined;
    let nextState = this.installTranscriptProjection(
      this.withCoverage(this.state, sessionId, nextCoverage),
      sessionId,
      newest,
    );
    nextState = this.withCoverage(nextState, sessionId, nextCoverage);
    return nextState;
  }

  private removeNotificationProjection(
    state: DashboardLiveState,
    id: string,
  ): DashboardLiveState {
    const notificationsById = { ...state.notificationsById };
    delete notificationsById[id];
    return { ...state, notificationsById };
  }

  setConnection(
    status: ConnectionStatus,
    error?: string,
    errorKind?: import('./http-client.js').DashboardHttpErrorKind,
  ): void {
    const normalizedStatus = status;
    const current = this.state.connection;
    if (
      current.status === normalizedStatus &&
      current.lastCursor === this.state.cursor &&
      current.error === error &&
      current.errorKind === errorKind
    )
      return;
    this.publish({
      ...this.state,
      connection: {
        status: normalizedStatus,
        lastCursor: this.state.cursor,
        ...(error ? { error } : {}),
        ...(errorKind ? { errorKind } : {}),
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
        ...(error ? {} : { errorKind: undefined }),
      },
    });
  }

  private updateDomain(
    _domain: 'shell' | 'session',
    sessionId: string | undefined,
    update: Partial<DomainSyncState> & { status: SyncStatus },
  ): void {
    const current = sessionId
      ? this.state.sessionSyncById[sessionId]
      : this.state.shellSync;
    const next = { ...(current ?? { generation: 0, sequence: 0 }), ...update };
    if (sessionId) {
      if (current && JSON.stringify(current) === JSON.stringify(next)) return;
      this.publish({
        ...this.state,
        sessionSyncById: { ...this.state.sessionSyncById, [sessionId]: next },
      });
      return;
    }
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    this.publish({ ...this.state, shellSync: next });
  }

  beginShellSync(
    generation: number,
    sequence = 0,
    preserveSequence = false,
  ): void {
    const current = this.state.shellSync;
    this.updateDomain('shell', undefined, {
      status: 'synchronizing',
      generation,
      sequence: preserveSequence ? current.sequence : sequence,
      sequenceKnown: preserveSequence ? current.sequenceKnown : false,
      error: undefined,
    });
  }

  completeShellSync(sequence: number): void {
    this.updateDomain('shell', undefined, {
      status: 'live',
      sequence,
      sequenceKnown: true,
      error: undefined,
    });
  }

  failShellSync(error: string): void {
    this.updateDomain('shell', undefined, { status: 'error', error });
  }

  beginSessionSync(
    sessionId: string,
    generation: number,
    cached = false,
    preserveSequence = false,
  ): void {
    const current = this.state.sessionSyncById[sessionId];
    if (current && current.generation !== generation)
      this.pendingSessionHistory.delete(sessionId);
    this.updateDomain('session', sessionId, {
      status: cached && current ? 'cached' : 'synchronizing',
      generation,
      sequence: preserveSequence && current ? current.sequence : 0,
      sequenceKnown:
        preserveSequence && current ? current.sequenceKnown : false,
      error: undefined,
    });
  }

  /** Suspend transport-owned domains without discarding their last ordering cut. */
  suspendShellSync(): void {
    const hasProjection =
      this.state.serverId !== undefined ||
      this.state.shellProjection !== undefined ||
      Object.keys(this.state.runtimesById).length > 0 ||
      Object.keys(this.state.sessionsById).length > 0;
    this.updateDomain('shell', undefined, {
      status: hasProjection ? 'cached' : 'empty',
      error: undefined,
    });
  }

  suspendSessionSync(sessionId: string): void {
    const current = this.state.sessionSyncById[sessionId];
    if (!current) return;
    const hasProjection =
      this.state.transcriptsBySessionId[sessionId] !== undefined ||
      this.state.sessionSnapshotsById[sessionId] !== undefined;
    this.updateDomain('session', sessionId, {
      status: hasProjection ? 'cached' : 'empty',
      error: undefined,
    });
  }

  completeSessionSync(sessionId: string, sequence: number): void {
    this.updateDomain('session', sessionId, {
      status: 'live',
      sequence,
      sequenceKnown: true,
      error: undefined,
    });
    this.flushPendingSessionHistory(sessionId);
  }

  failSessionSync(sessionId: string, error: string): void {
    this.updateDomain('session', sessionId, { status: 'error', error });
  }

  /** Install the shell feed's authoritative snapshot at its own sequence. */
  acceptShellSnapshot(
    next: BrowserSnapshot,
    sequence: number,
    generation: number,
    authoritativeRebase = false,
  ): boolean {
    const current = this.state.shellSync;
    if (
      current.generation !== generation ||
      (!authoritativeRebase &&
        current.sequenceKnown &&
        sequence <= current.sequence)
    )
      return false;
    const accepted = this.installSnapshot(next, {
      source: 'sse',
      authoritativeRebase,
    });
    if (!accepted) return false;
    this.publish({
      ...this.state,
      shellSync: {
        status: 'synchronizing',
        generation,
        sequence,
        sequenceKnown: true,
      },
    });
    return true;
  }

  /**
   * Apply one contiguous semantic shell patch without a finite snapshot read.
   * A false result is a transport recovery signal, never a request to invent
   * state from a partial payload.
   */
  acceptShellEvent(event: ShellFeedEvent, generation: number): boolean {
    const sync = this.state.shellSync;
    if (
      sync.generation !== generation ||
      !sync.sequenceKnown ||
      event.sequence <= sync.sequence ||
      event.sequence !== sync.sequence + 1
    )
      return false;

    let nextState = this.state;
    switch (event.domain) {
      case 'runtime': {
        if (event.data.kind === 'remove') {
          const runtimesById = { ...nextState.runtimesById };
          delete runtimesById[event.data.runtimeId];
          this.runtimeReducerStates.delete(event.data.runtimeId);
          nextState = { ...nextState, runtimesById };
        } else {
          const runtime = event.data.runtime as ShellRuntimeSnapshot;
          nextState = this.installRuntimeProjection(nextState, runtime);
          this.runtimeReducerStates.set(
            runtime.runtimeId,
            createRuntimeReducerState(runtime),
          );
        }
        break;
      }
      case 'interaction': {
        const data = event.data;
        const runtime = nextState.runtimesById[data.runtimeId];
        if (!runtime) return false;
        const pending = [...runtime.pendingInteractions];
        if (data.kind === 'remove') {
          const index = pending.findIndex(
            (item) => item.id === data.interactionId,
          );
          if (index >= 0) pending.splice(index, 1);
        } else {
          const index = pending.findIndex(
            (item) => item.id === data.interaction.id,
          );
          if (index >= 0) pending[index] = data.interaction;
          else pending.push(data.interaction);
        }
        nextState = this.installRuntimeProjection(nextState, {
          ...runtime,
          pendingInteractions: pending,
        });
        break;
      }
      case 'session-index': {
        if (event.data.kind === 'replace')
          nextState = this.installSessionReplacementProjection(
            nextState,
            event.data.sessions,
          );
        else {
          for (const session of event.data.upsert)
            nextState = this.installSessionProjection(nextState, session);
          if (event.data.remove.length > 0) {
            const sessionsById = { ...nextState.sessionsById };
            for (const id of event.data.remove) delete sessionsById[id];
            nextState = { ...nextState, sessionsById };
          }
        }
        break;
      }
      case 'workspace':
        nextState = {
          ...nextState,
          ...(event.data.shellProjection === undefined
            ? {}
            : { shellProjection: event.data.shellProjection }),
          workspacesById: indexed(event.data.workspaces),
          workspaceOrder: event.data.workspaces.map((item) => item.id),
        };
        break;
      case 'orchestration':
        nextState = {
          ...nextState,
          ...(event.data.shellProjection === undefined
            ? {}
            : { shellProjection: event.data.shellProjection }),
          projects: event.data.projects,
          checkouts: event.data.checkouts,
          threads: event.data.threads,
          runs: event.data.runs,
        };
        break;
      case 'usage':
        nextState = {
          ...nextState,
          ...(event.data.shellProjection === undefined
            ? {}
            : { shellProjection: event.data.shellProjection }),
          usage: event.data.usage,
        };
        break;
      case 'notification':
        nextState = {
          ...nextState,
          ...(event.data.shellProjection === undefined
            ? {}
            : { shellProjection: event.data.shellProjection }),
          notificationsById: indexed(event.data.unread),
        };
        break;
    }
    this.publish({
      ...nextState,
      revision: Math.max(nextState.revision, event.revision),
      cursor: event.sequence,
      connection: {
        ...nextState.connection,
        lastCursor: event.sequence,
      },
      shellSync: {
        ...nextState.shellSync,
        sequence: event.sequence,
        sequenceKnown: true,
      },
    });
    return true;
  }

  /** Route session feed snapshots through the existing transcript projection. */
  acceptSessionSnapshot(
    response: AuthoritativeSessionSnapshot,
    sequence: number,
    generation: number,
    authoritativeRebase = false,
    expectedSessionId = response.metadata.id,
  ): boolean {
    const current = this.state.sessionSyncById[expectedSessionId];
    const ordering = acceptTranscriptSnapshotOrdering(
      current,
      sequence,
      generation,
      authoritativeRebase,
    );
    if (!ordering.accepted) {
      if (ordering.reason === 'generation')
        this.resetSessionHistoryToNewest(expectedSessionId);
      return false;
    }
    if (response.metadata.id !== expectedSessionId) {
      this.resetSessionHistoryToNewest(expectedSessionId);
      return false;
    }
    this.pendingSessionHistory.delete(expectedSessionId);
    const projection = this.hydrateSession(response, {
      replace: true,
      expectedSessionId,
    });
    if (!projection) return false;
    const coverage =
      this.state.sessionHistoryCoverageById[response.metadata.id];
    this.publish({
      ...this.state,
      sessionSyncById: {
        ...this.state.sessionSyncById,
        [response.metadata.id]: {
          status: 'synchronizing',
          generation,
          sequence,
          sequenceKnown: true,
        },
      },
      sessionSnapshotsById: {
        ...this.state.sessionSnapshotsById,
        [response.metadata.id]: {
          ...response,
          ...(coverage ? { history: historyFromPages(coverage.pages) } : {}),
        },
      },
    });
    return true;
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
    if (decision.reset && !provenance.authoritativeRebase) {
      this.generation += 1;
      this.latestSessionRequestOrders.clear();
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
      });
      return true;
    }
    if (decision.reset) {
      this.generation += 1;
      this.latestSessionRequestOrders.clear();
      this.runtimeReducerStates.clear();
    }
    if (
      this.state.snapshotCursor > next.cursor &&
      provenance.authoritativeRebase !== true
    )
      return false;
    // Finite reads never advance live feed ordering. Subscription snapshots
    // and explicit rebases carry their own domain sequence.
    const advanceCursor =
      provenance.source !== 'http' || provenance.rebaseCursor === true;
    const cursor = advanceCursor ? next.cursor : this.state.cursor;
    const projected = this.installSnapshotProjection(this.state, next);
    this.publish({
      ...projected,
      cursor,
      connection: { ...projected.connection, lastCursor: cursor },
    });
    return true;
  }

  applyEventEnvelope(
    envelope: DashboardEventEnvelope,
    domain?: { sessionId: string; generation: number },
  ): boolean {
    const priorCursor = domain
      ? (this.state.sessionSyncById[domain.sessionId]?.sequence ?? 0)
      : this.state.cursor;
    const previousRuntimeSessionId = envelope.runtimeId
      ? this.state.runtimesById[envelope.runtimeId]?.session.id
      : undefined;
    if (
      !domain &&
      envelope.snapshot &&
      envelope.snapshot.serverId !== this.state.serverId &&
      !this.installSnapshot(envelope.snapshot, { source: 'sse' })
    )
      return false;
    if (envelope.cursor <= priorCursor) return false;
    if (
      !domain &&
      envelope.cursor > priorCursor + 1 &&
      this.state.serverId !== undefined &&
      !envelope.snapshot
    )
      return false;
    if (
      !domain &&
      envelope.snapshot &&
      envelope.snapshot.serverId === this.state.serverId &&
      envelope.snapshot.cursor >= this.state.snapshotCursor
    )
      this.installSnapshot(envelope.snapshot, { source: 'sse' });
    let nextState = this.state;
    let runtimeOrderingAccepted = envelope.runtimeId === undefined;
    const sessionId = sessionIdForEvent(envelope);
    const liveMessage = liveMessageIdentity(envelope);
    if (sessionId && liveMessage?.role === 'user')
      nextState = withOptimisticSessionTitle(
        nextState,
        sessionId,
        liveMessage.content,
      );
    if (sessionId && envelope.event.type !== 'runtime.hello') {
      const currentProjection = nextState.transcriptsBySessionId[sessionId];
      const nextProjection = reduceSessionTranscriptEvent(
        currentProjection,
        sessionId,
        envelope,
      );
      if (nextProjection && nextProjection !== currentProjection)
        nextState = this.installTranscriptProjection(
          nextState,
          sessionId,
          nextProjection,
        );
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
          runtimeOrderingAccepted = ordering.accepted;
          if (ordering.accepted)
            this.runtimeReducerStates.set(envelope.runtimeId, {
              snapshot: currentRuntime,
              ...ordering.state,
            });
        } else {
          const reduced = applyRuntimeEvent(runtimeState, envelope);
          runtimeOrderingAccepted = reduced.accepted;
          if (reduced.accepted) {
            this.runtimeReducerStates.set(envelope.runtimeId, reduced.state);
            if (reduced.state.snapshot !== currentRuntime)
              nextState = this.installRuntimeProjection(
                nextState,
                reduced.state.snapshot,
              );
          }
        }
      } else if (envelope.event.type === 'runtime.hello') {
        // A reconnect hello is authoritative even if a shell was evicted while
        // the stream was offline; keep the event reducer as the single owner.
        const reduced = applyRuntimeEvent(
          createRuntimeReducerState(envelope.event.snapshot),
          envelope,
        );
        runtimeOrderingAccepted = reduced.accepted;
        if (reduced.accepted) {
          this.runtimeReducerStates.set(envelope.runtimeId, reduced.state);
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
      (event.type === 'runtime.hello' ||
        event.type === 'session.changed' ||
        event.type === 'session.snapshot');
    if (
      sessionId &&
      semanticSessionUpdate &&
      (event.type !== 'runtime.hello' || runtimeOrderingAccepted)
    )
      sessionChangeById = {
        ...sessionChangeById,
        [sessionId]: (sessionChangeById[sessionId] ?? 0) + 1,
      };
    if (
      envelope.runtimeId &&
      sessionId &&
      runtimeOrderingAccepted &&
      event.type === 'runtime.stateChanged' &&
      event.snapshot?.online === false
    ) {
      const current = nextState.sessionsById[sessionId];
      if (current?.activeRuntimeId === envelope.runtimeId) {
        const sessionsById = { ...nextState.sessionsById };
        const { activeRuntimeId: _activeRuntimeId, ...metadata } = current;
        sessionsById[sessionId] = metadata;
        nextState = { ...nextState, sessionsById };
      }
    }
    if (
      sessionId &&
      (event.type === 'session.changed' ||
        event.type === 'session.snapshot' ||
        (event.type === 'runtime.hello' && runtimeOrderingAccepted))
    ) {
      const sessionUpdate =
        event.type === 'runtime.hello' ? event.snapshot.session : event.session;
      const current = nextState.sessionsById[sessionId];
      const hasAuthoritativeTitle =
        sessionUpdate.name !== undefined || sessionUpdate.title !== undefined;
      if (current) {
        const metadata = {
          ...current,
          ...(sessionUpdate.name === undefined
            ? {}
            : { name: sessionUpdate.name }),
          ...(sessionUpdate.title === undefined
            ? {}
            : { title: sessionUpdate.title }),
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
      if (event.type === 'runtime.hello' && envelope.runtimeId) {
        const sessionsById = { ...nextState.sessionsById };
        const runtime = nextState.runtimesById[envelope.runtimeId];
        const existing = sessionsById[sessionId];
        sessionsById[sessionId] = existing
          ? { ...existing, activeRuntimeId: envelope.runtimeId }
          : {
              id: sessionId,
              file: sessionUpdate.file ?? '',
              cwd: sessionUpdate.cwd ?? runtime?.cwd ?? '',
              updatedAt: runtime?.lastSeenAt ?? Date.now(),
              ...(sessionUpdate.name === undefined
                ? {}
                : { name: sessionUpdate.name }),
              ...(sessionUpdate.title === undefined
                ? {}
                : { title: sessionUpdate.title }),
              activeRuntimeId: envelope.runtimeId,
            };
        if (
          previousRuntimeSessionId &&
          previousRuntimeSessionId !== sessionId
        ) {
          const previous = sessionsById[previousRuntimeSessionId];
          if (previous?.activeRuntimeId === envelope.runtimeId) {
            const { activeRuntimeId: _activeRuntimeId, ...previousMetadata } =
              previous;
            sessionsById[previousRuntimeSessionId] = previousMetadata;
          }
        }
        nextState = { ...nextState, sessionsById };
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
    const domainState = domain
      ? this.state.sessionSyncById[domain.sessionId]
      : undefined;
    this.publish(
      {
        ...nextState,
        sessionChangeById,
        sessionReplacementByRuntimeId,
        sessionReplacementBySessionId,
        ...(domain
          ? {
              sessionSyncById: {
                ...nextState.sessionSyncById,
                [domain.sessionId]: {
                  ...(domainState ?? {
                    status: 'synchronizing' as const,
                    generation: domain.generation,
                    sequence: 0,
                    sequenceKnown: false,
                  }),
                  sequence: envelope.cursor,
                  sequenceKnown: true,
                  generation: domain.generation,
                },
              },
            }
          : {
              cursor: envelope.cursor,
              connection: {
                ...nextState.connection,
                lastCursor: envelope.cursor,
              },
            }),
      },
      event.type === 'message.updated' || event.type === 'tool.updated',
    );
    return true;
  }

  /** Reduce one session-feed event through the canonical runtime/transcript path. */
  acceptSessionEvent(
    sessionId: string,
    sequence: number,
    value: {
      event: DashboardEventEnvelope['event'];
      runtimeId?: string;
      runtimeEpoch?: string;
      runtimeSeq?: number;
    },
    generation: number,
  ): boolean {
    const current = this.state.sessionSyncById[sessionId];
    const ordering = acceptTranscriptEventOrdering(
      current,
      sequence,
      generation,
    );
    if (!ordering.accepted) {
      this.resetSessionHistoryToNewest(sessionId);
      return false;
    }
    const coverage = this.state.sessionHistoryCoverageById[sessionId];
    if (
      coverage &&
      value.runtimeEpoch !== undefined &&
      value.runtimeEpoch !== coverage.runtimeEpoch
    )
      this.resetSessionHistoryToNewest(sessionId);
    if (value.event.type === 'session.transcript.reset') {
      this.resetSessionHistoryToNewest(sessionId);
      return false;
    }
    const accepted = this.applyEventEnvelope(
      {
        cursor: sequence,
        emittedAt: Date.now(),
        sessionId,
        ...(value.runtimeId === undefined
          ? {}
          : { runtimeId: value.runtimeId }),
        ...(value.runtimeEpoch === undefined
          ? {}
          : { runtimeEpoch: value.runtimeEpoch }),
        ...(value.runtimeSeq === undefined
          ? {}
          : { runtimeSeq: value.runtimeSeq }),
        event: value.event as never,
      },
      { sessionId, generation },
    );
    if (accepted) this.flushPendingSessionHistory(sessionId);
    return accepted;
  }

  /** Install an authoritative session-feed snapshot. */
  hydrateSession(
    response: AuthoritativeSessionSnapshot,
    options: { replace?: boolean; expectedSessionId?: string } = {},
  ): TranscriptProjection | undefined {
    const expectedSessionId = options.expectedSessionId;
    if (
      expectedSessionId !== undefined &&
      response.metadata.id !== expectedSessionId
    ) {
      this.resetSessionHistoryToNewest(expectedSessionId);
      return undefined;
    }
    const requestOrder = options.replace
      ? undefined
      : (response as ClientAuthoritativeSessionSnapshot)[SESSION_REQUEST_ORDER];
    const sessionId = response.metadata.id;
    if (
      response.serverId !== undefined &&
      this.state.serverId !== undefined &&
      response.serverId !== this.state.serverId
    ) {
      this.resetSessionHistoryToNewest(sessionId);
      return undefined;
    }
    const snapshotCursor = response.cursor ?? this.state.cursor;
    if (requestOrder !== undefined) {
      const accepted = this.latestSessionRequestOrders.get(sessionId);
      if (accepted !== undefined && requestOrder < accepted) {
        this.resetSessionHistoryToNewest(sessionId);
        return undefined;
      }
    }
    const previousProjection = this.state.transcriptsBySessionId[sessionId];
    const previousCoverage = this.state.sessionHistoryCoverageById[sessionId];
    if (
      !options.replace &&
      previousProjection &&
      response.cursor !== undefined &&
      response.cursor < previousProjection.lastCursor
    ) {
      // A stale/rewrite response must not leave a verified cursor claiming
      // continuity through data it never observed.
      this.resetSessionHistoryToNewest(sessionId);
      return undefined;
    }
    // Authoritative feed snapshots replace the selected domain directly.
    // Finite mutation/recovery responses retain their request-order guard but
    // preserve an incomplete established history baseline.
    const coveredCursor = snapshotCursor;
    const installedTranscript = installAuthoritativeTranscript({
      response,
      previousProjection,
      previousCoverage,
      generation: this.generation,
      serverId: this.state.serverId,
      coveredCursor,
      replace: options.replace,
    });
    const { projection, activeIsCurrent } = installedTranscript;
    const nextCoverage = installedTranscript.coverage;
    const active = response.active;
    const activeEpoch = active?.runtimeEpoch ?? response.runtimeEpoch;
    const currentMetadata = this.state.sessionsById[response.metadata.id];
    const optimisticTitle =
      this.state.optimisticSessionTitlesById[response.metadata.id];
    const metadata = {
      ...response.metadata,
      ...(response.metadata.startedAt === undefined &&
      currentMetadata?.startedAt !== undefined
        ? { startedAt: currentMetadata.startedAt }
        : {}),
      ...(response.metadata.activeRuntimeId !== undefined && currentMetadata
        ? { updatedAt: currentMetadata.updatedAt }
        : {}),
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
    nextState = this.withCoverage(nextState, sessionId, nextCoverage);
    // Keep pending questions and delegate status in the existing runtime
    // projection. Historical pages intentionally carry an empty active
    // overlay, so they cannot overwrite live runtime state.
    const activeRuntimeId =
      active?.runtimeId ?? response.metadata.activeRuntimeId;
    const activeRuntime = activeRuntimeId
      ? nextState.runtimesById[activeRuntimeId]
      : undefined;
    const activeRuntimeOrdering = activeRuntimeId
      ? this.runtimeReducerStates.get(activeRuntimeId)
      : undefined;
    const runtimeOverlayAccepted =
      activeIsCurrent &&
      active !== undefined &&
      activeRuntime !== undefined &&
      (activeRuntimeOrdering === undefined ||
        (activeRuntimeOrdering.lastCursor <= (response.cursor ?? 0) &&
          (active.runtimeEpoch === undefined ||
            activeRuntimeOrdering.runtimeEpoch === undefined ||
            active.runtimeEpoch === activeRuntimeOrdering.runtimeEpoch) &&
          (active.runtimeSeq === undefined ||
            activeRuntimeOrdering.runtimeEpoch !== activeEpoch ||
            activeRuntimeOrdering.lastRuntimeSeq <= active.runtimeSeq)));
    if (runtimeOverlayAccepted && activeRuntime && active) {
      const delegateSurface = activeRuntime.extensionSurfaces?.find(
        (surface) => surface.rendererId === 'delegate.status',
      );
      const delegateStatuses = active.delegates.map((run) => ({
        id: run.runId,
        ...run,
      }));
      const delegateStatusSurface = {
        id: 'delegate.status',
        rendererId: 'delegate.status',
        placement: 'main' as const,
        viewModel: { version: 1, statuses: delegateStatuses },
      } as NonNullable<RuntimeSnapshot['extensionSurfaces']>[number];
      const extensionSurfaces: RuntimeSnapshot['extensionSurfaces'] =
        activeRuntime.extensionSurfaces
          ? delegateSurface
            ? activeRuntime.extensionSurfaces.map((surface) =>
                surface === delegateSurface ? delegateStatusSurface : surface,
              )
            : active.delegates.length > 0
              ? [...activeRuntime.extensionSurfaces, delegateStatusSurface]
              : activeRuntime.extensionSurfaces
          : active.delegates.length > 0
            ? [delegateStatusSurface]
            : undefined;
      const projectedRuntime = {
        ...activeRuntime,
        pendingInteractions: [...active.pendingInteractions],
        ...(extensionSurfaces === undefined ? {} : { extensionSurfaces }),
      };
      nextState = {
        ...nextState,
        runtimesById: {
          ...nextState.runtimesById,
          [activeRuntime.runtimeId]: projectedRuntime,
        },
      };
    }
    this.publish(nextState);
    if (requestOrder !== undefined)
      this.latestSessionRequestOrders.set(response.metadata.id, requestOrder);
    return projection;
  }

  /**
   * Validate and atomically prepend one or more pages. A page ahead of the
   * applied session-feed sequence is parked and published exactly when that
   * watermark is reached. Continuation chains publish only as one unit.
   */
  prependSessionHistoryPages(
    responses: readonly AuthoritativeSessionSnapshot[],
    expectedSessionId?: string,
  ): TranscriptProjection | undefined {
    if (responses.length === 0) return undefined;
    const first = responses[0];
    const sessionId = expectedSessionId ?? first?.metadata.id;
    if (!sessionId) return undefined;
    const current = this.state.transcriptsBySessionId[sessionId];
    const coverage = this.state.sessionHistoryCoverageById[sessionId];
    if (!current || !coverage) return undefined;
    const pending = this.pendingSessionHistory.get(sessionId);
    const resumingPending = pending?.responses === responses;
    if (resumingPending) this.pendingSessionHistory.delete(sessionId);
    else {
      const watermark = classifyHistoryPageWatermark(
        this.state.sessionSyncById[sessionId],
        responses,
      );
      if (watermark.status === 'ahead') {
        const sync = this.state.sessionSyncById[sessionId];
        this.pendingSessionHistory.set(sessionId, {
          responses,
          expectedSessionId: sessionId,
          generation: sync?.generation ?? this.generation,
          sequence: watermark.sequence,
        });
        return current;
      }
      if (watermark.status !== 'ready') {
        this.resetSessionHistoryToNewest(sessionId);
        return undefined;
      }
    }
    const serverId = this.state.serverId;
    const seenRanges = new Set(
      coverage.pages.map((page) => `${page.start}:${page.end}`),
    );
    const seenCursors = new Set(
      coverage.pages.flatMap((page) =>
        page.nextBefore === undefined ? [] : [page.nextBefore],
      ),
    );
    let workingPages = [...coverage.pages];
    let workingCoverage = coverage;
    let projection = current;
    for (const response of responses) {
      const page = this.pageCoverage(response);
      const emptyOriginPlaceholder =
        workingCoverage.coveredStart === 0 &&
        workingCoverage.coveredEnd === 0 &&
        !workingCoverage.hasOlder &&
        workingPages.length === 1 &&
        page?.start === 0;
      if (
        !page ||
        response.metadata.id !== sessionId ||
        (response.serverId ?? serverId) !== coverage.serverId ||
        (response.runtimeEpoch !== undefined &&
          response.runtimeEpoch !== coverage.runtimeEpoch) ||
        response.history?.version !== coverage.version ||
        (!emptyOriginPlaceholder &&
          (page.end !== workingCoverage.coveredStart ||
            page.start >= workingCoverage.coveredStart)) ||
        seenRanges.has(`${page.start}:${page.end}`) ||
        (page.nextBefore !== undefined && seenCursors.has(page.nextBefore))
      ) {
        const reset = this.resetCoverageToNewest(sessionId, current, coverage);
        this.publish(reset);
        return undefined;
      }
      if (page.byteCount === Number.POSITIVE_INFINITY) {
        const reset = this.resetCoverageToNewest(sessionId, current, coverage);
        this.publish(reset);
        return reset.transcriptsBySessionId[sessionId];
      }
      seenRanges.add(`${page.start}:${page.end}`);
      if (page.nextBefore !== undefined) seenCursors.add(page.nextBefore);
      workingPages = [page, ...workingPages];
      workingCoverage =
        this.coverageWithPages(
          workingPages,
          coverage.serverId,
          coverage.runtimeEpoch,
        ) ?? workingCoverage;
      const older = hydrateTranscript(response.entries, sessionId, {
        fallbackEntryIds: true,
        fallbackEntryOffset: page.start,
      });
      projection = mergePrependedTranscript(projection, older);
    }

    if (
      workingCoverage.pageCount > SESSION_HISTORY_BUDGET.maxPages ||
      workingCoverage.entryCount > SESSION_HISTORY_BUDGET.maxEntries ||
      workingCoverage.byteCount > SESSION_HISTORY_BUDGET.maxBytes
    ) {
      // The oldest pages cannot be discarded from a single merged projection
      // without retaining a reloadable boundary. Reset to the newest page
      // instead of rejecting forever at the cap.
      const reset = this.resetCoverageToNewest(sessionId, current, coverage);
      this.publish(reset);
      return reset.transcriptsBySessionId[sessionId];
    }

    const currentMetadata = this.state.sessionsById[sessionId];
    const optimisticTitle = this.state.optimisticSessionTitlesById[sessionId];
    const metadata = {
      ...first.metadata,
      ...(first.metadata.startedAt === undefined &&
      currentMetadata?.startedAt !== undefined
        ? { startedAt: currentMetadata.startedAt }
        : {}),
      ...(first.metadata.activeRuntimeId !== undefined && currentMetadata
        ? { updatedAt: currentMetadata.updatedAt }
        : {}),
      ...(first.metadata.name === undefined && currentMetadata?.name
        ? { name: currentMetadata.name }
        : {}),
      ...(first.metadata.title === undefined
        ? optimisticTitle !== undefined
          ? { title: optimisticTitle }
          : currentMetadata?.title !== undefined
            ? { title: currentMetadata.title }
            : {}
        : {}),
    };
    let nextState = this.installSessionProjection(this.state, metadata);
    if (
      first.metadata.name !== undefined ||
      first.metadata.title !== undefined
    ) {
      const optimistic = { ...nextState.optimisticSessionTitlesById };
      delete optimistic[sessionId];
      nextState = { ...nextState, optimisticSessionTitlesById: optimistic };
    }
    nextState = this.installTranscriptProjection(
      nextState,
      sessionId,
      projection,
    );
    nextState = this.withCoverage(nextState, sessionId, workingCoverage);
    const currentSnapshot = nextState.sessionSnapshotsById[sessionId];
    if (currentSnapshot)
      nextState = {
        ...nextState,
        sessionSnapshotsById: {
          ...nextState.sessionSnapshotsById,
          [sessionId]: { ...currentSnapshot, history: first.history },
        },
      };
    this.publish(nextState);
    return projection;
  }

  /** Prepend one verified page; chains use prependSessionHistoryPages. */
  prependSessionHistory(
    response: AuthoritativeSessionSnapshot,
  ): TranscriptProjection | undefined {
    return this.prependSessionHistoryPages([response]);
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
    ) {
      const session = tryParseAuthoritativeSessionSnapshot(result);
      if (session) this.hydrateSession(session);
    }
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
    if (current?.name !== undefined || current?.title !== undefined)
      return false;
    const projection = this.state.transcriptsBySessionId[id];
    if (
      projection &&
      Object.values(projection.items).some(
        (item) => item.kind === 'message' && item.role === 'user',
      )
    )
      return false;
    const nextState = withOptimisticSessionTitle(this.state, id, prompt);
    if (nextState === this.state) return false;
    this.publish(nextState);
    return true;
  }

  /** Retain a launched chat's first prompt until its runtime reveals the session id. */
  optimisticallyTitleRuntime(runtimeId: string, prompt: string): boolean {
    const runtime = this.state.runtimesById[runtimeId];
    if (runtime)
      return this.optimisticallyTitleSession(runtime.session.id, prompt);
    const title = deriveSessionTitle([
      { type: 'message', message: { role: 'user', content: prompt } },
    ]);
    if (!title) return false;
    this.publish({
      ...this.state,
      optimisticRuntimeTitlesById: {
        ...this.state.optimisticRuntimeTitlesById,
        [runtimeId]: title,
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
    this.latestSessionRequestOrders.clear();
    this.pendingSessionHistory.clear();
    this.publish(emptyState());
  }

  connect(client: DashboardHttpClient): () => void {
    this.connectionRuntime?.stop();
    this.connectionRuntime = new DashboardConnectionRuntime({
      client,
      store: this,
    });
    return this.connectionRuntime.start();
  }

  reconnect(): void {
    this.connectionRuntime?.reconnect();
  }

  retryAuthentication(): void {
    this.connectionRuntime?.retryAuthentication();
  }

  reconnectSession(sessionId: string): void {
    this.connectionRuntime?.reconnectSession(sessionId);
  }

  acquireSession(sessionId: string) {
    return this.connectionRuntime?.acquireSession(sessionId);
  }

  releaseSession(sessionId: string): void {
    this.connectionRuntime?.releaseSession(sessionId);
  }

  markSessionCached(
    sessionId: string,
    generation: number,
    sequence: number,
    sequenceKnown: boolean,
  ): boolean {
    if (
      !this.state.sessionSnapshotsById[sessionId] ||
      !this.state.transcriptsBySessionId[sessionId]
    )
      return false;
    this.updateDomain('session', sessionId, {
      status: 'cached',
      generation,
      sequence,
      sequenceKnown,
      error: undefined,
    });
    return true;
  }

  evictSessionProjection(sessionId: string): void {
    this.pendingSessionHistory.delete(sessionId);
    const sessionSnapshotsById = { ...this.state.sessionSnapshotsById };
    const sessionSyncById = { ...this.state.sessionSyncById };
    const transcriptsBySessionId = { ...this.state.transcriptsBySessionId };
    const sessionChangeById = { ...this.state.sessionChangeById };
    const hadProjection =
      sessionSnapshotsById[sessionId] !== undefined ||
      sessionSyncById[sessionId] !== undefined ||
      transcriptsBySessionId[sessionId] !== undefined;
    if (!hadProjection) return;
    delete sessionSnapshotsById[sessionId];
    delete sessionSyncById[sessionId];
    delete transcriptsBySessionId[sessionId];
    delete sessionChangeById[sessionId];
    const sessionHistoryCoverageById = {
      ...this.state.sessionHistoryCoverageById,
    };
    delete sessionHistoryCoverageById[sessionId];
    this.latestSessionRequestOrders.delete(sessionId);
    this.publish({
      ...this.state,
      sessionSnapshotsById,
      sessionSyncById,
      transcriptsBySessionId,
      sessionChangeById,
      sessionHistoryCoverageById,
    });
  }
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
      | 'shellProjection'
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
    shellProjection: state.shellProjection,
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
    ...(state.shellProjection === undefined
      ? {}
      : { shellProjection: state.shellProjection }),
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
export const selectShellSync = (state: DashboardLiveState) => state.shellSync;
export const selectSessionSync =
  (sessionId: string) => (state: DashboardLiveState) =>
    state.sessionSyncById[sessionId] ?? {
      status: 'empty' as const,
      generation: 0,
      sequence: 0,
      sequenceKnown: false,
    };
export const selectTranscript =
  (sessionId: string) => (state: DashboardLiveState) =>
    state.transcriptsBySessionId[sessionId];
export const selectSessionSnapshot =
  (sessionId: string) => (state: DashboardLiveState) =>
    state.sessionSnapshotsById[sessionId];
export const selectSessionHistoryCoverage =
  (sessionId: string) => (state: DashboardLiveState) =>
    state.sessionHistoryCoverageById[sessionId];
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
  (sessionId: string) => (state: DashboardLiveState) => {
    const activeRuntimeId = state.sessionsById[sessionId]?.activeRuntimeId;
    const activeRuntime = activeRuntimeId
      ? state.runtimesById[activeRuntimeId]
      : undefined;
    if (activeRuntime?.session.id === sessionId) return activeRuntime;
    const matching = Object.values(state.runtimesById).filter(
      (runtime) => runtime.session.id === sessionId,
    );
    return matching.find((runtime) => runtime.online !== false) ?? matching[0];
  };
