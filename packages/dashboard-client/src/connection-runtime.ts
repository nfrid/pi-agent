import type {
  FeedCaughtUp,
  SessionFeedMessage,
  ShellFeedMessage,
} from '@pi-dashboard/protocol';
import type { DashboardTokenStore } from './authentication.js';
import type { FetchLike } from './http-client.js';
import {
  DashboardHttpClient,
  DashboardHttpError,
  type DashboardHttpErrorKind,
  dashboardHttpErrorKind,
} from './http-client.js';
import type { DashboardLiveStore } from './store.js';
import type { DashboardTrpcClient } from './trpc-client.js';

export type FeedCursorValue = string;

type ShellValue = ShellFeedMessage;
type SessionValue = SessionFeedMessage;
type Subscription = { unsubscribe: () => void };

type DomainEntry = {
  id: string;
  generation: number;
  refs: number;
  sequence: number;
  sequenceKnown: boolean;
  lastEventId?: FeedCursorValue;
  subscription?: Subscription;
  opening: number;
  rebasing: boolean;
};

/** Maximum inactive session projections retained in memory. */
export const SESSION_PROJECTION_CACHE_LIMIT = 2;

export interface SessionSubscriptionHandle {
  readonly sessionId: string;
  release(): void;
}

export interface DashboardConnectionRuntimeOptions {
  /** Supply a preconfigured client, or let the runtime own endpoint selection. */
  client?: DashboardHttpClient;
  baseUrl?: string;
  candidateBaseUrls?: string[];
  fetch?: FetchLike;
  tokenStore?: DashboardTokenStore;
  store: DashboardLiveStore;
  /** Primarily useful for deterministic browser lifecycle tests. */
  isOnline?: () => boolean;
  visibilityStaleMs?: number;
}

function trackedValue<T>(value: unknown): { id?: string; data: T } {
  if (
    value &&
    typeof value === 'object' &&
    'id' in value &&
    'data' in value &&
    typeof (value as { id?: unknown }).id === 'string'
  ) {
    const tracked = value as { id: string; data: unknown };
    // tRPC's subscription link retains the tracked envelope while the SSE
    // adapter may already have serialized one. Normalize both forms here.
    if (
      tracked.data &&
      typeof tracked.data === 'object' &&
      'id' in tracked.data &&
      'data' in tracked.data &&
      typeof (tracked.data as { id?: unknown }).id === 'string'
    )
      return tracked.data as { id: string; data: T };
    return tracked as { id: string; data: T };
  }
  return { data: value as T };
}

function numericSequence(value: unknown): number | undefined {
  if (
    value &&
    typeof value === 'object' &&
    'sequence' in value &&
    Number.isSafeInteger((value as { sequence?: unknown }).sequence)
  )
    return (value as { sequence: number }).sequence;
  return undefined;
}

function isCaughtUp(value: unknown): value is FeedCaughtUp {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { type?: unknown }).type === 'caught-up',
  );
}

function connectionErrorKind(
  error: unknown,
): DashboardHttpErrorKind | undefined {
  const classified = dashboardHttpErrorKind(error);
  if (classified) return classified;
  if (error instanceof DashboardHttpError)
    return error.status === 401 || error.status === 403
      ? 'authentication'
      : undefined;
  const source =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : {};
  const data =
    source.data && typeof source.data === 'object'
      ? (source.data as Record<string, unknown>)
      : {};
  const shape =
    source.shape && typeof source.shape === 'object'
      ? (source.shape as Record<string, unknown>)
      : {};
  const cause =
    source.cause && typeof source.cause === 'object'
      ? (source.cause as Record<string, unknown>)
      : {};
  const codes = [data.code, shape.code, source.code, cause.code];
  if (
    codes.some(
      (code) =>
        code === 401 ||
        code === 403 ||
        code === 'UNAUTHORIZED' ||
        code === 'FORBIDDEN',
    )
  )
    return 'authentication';
  if (data.domainCode === 'protocol-mismatch') return 'protocol-mismatch';
  return undefined;
}

function messageError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the browser's tRPC feed lifecycle. tRPC/httpSubscriptionLink owns
 * retry and Last-Event-ID resume; this class only performs explicit lifecycle
 * replacement (offline/visibility) and deterministic feed rebases.
 */
export class DashboardConnectionRuntime {
  private readonly client: DashboardHttpClient;
  private readonly store: DashboardLiveStore;
  private readonly isOnline: () => boolean;
  private readonly visibilityStaleMs: number;
  private trpc?: DashboardTrpcClient;
  private started = false;
  private shellGeneration = 0;
  private shellSequence = 0;
  private shellSequenceKnown = false;
  private shellSnapshotId?: FeedCursorValue;
  private shellOpening = 0;
  private shellSubscription?: Subscription;
  private shellRebasing = false;
  private sessions = new Map<string, DomainEntry>();
  private readonly inactiveSessions = new Map<string, true>();
  private hiddenAt?: number;
  private listenersInstalled = false;
  private readonly onOnline = () => {
    if (this.started) {
      this.replaceSubscriptions();
    }
  };
  private readonly onOffline = () => {
    this.store.setConnection('offline');
    this.closeSubscriptions();
  };
  private readonly onVisibilityChange = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') {
      this.hiddenAt = Date.now();
      return;
    }
    const hiddenAt = this.hiddenAt;
    this.hiddenAt = undefined;
    if (
      this.started &&
      hiddenAt !== undefined &&
      Date.now() - hiddenAt >= this.visibilityStaleMs
    )
      this.replaceSubscriptions();
  };

  constructor(options: DashboardConnectionRuntimeOptions) {
    this.client =
      options.client ??
      new DashboardHttpClient({
        baseUrl: options.baseUrl,
        candidateBaseUrls: options.candidateBaseUrls,
        fetch: options.fetch,
        tokenStore: options.tokenStore,
      });
    this.store = options.store;
    this.isOnline =
      options.isOnline ??
      (() => typeof navigator === 'undefined' || navigator.onLine);
    this.visibilityStaleMs = options.visibilityStaleMs ?? 15_000;
  }

  /** Start is idempotent and always leaves at most one shell subscription. */
  start(): () => void {
    if (this.started) return () => this.stop();
    this.started = true;
    this.installListeners();
    if (!this.isOnline()) {
      this.store.setConnection('offline');
      return () => this.stop();
    }
    this.store.setConnection('connecting');
    void this.openShell(false);
    for (const entry of this.sessions.values())
      void this.openSession(entry, false);
    return () => this.stop();
  }

  startShell(): () => void {
    return this.start();
  }

  /** Explicitly replace live subscriptions without adding a retry timer. */
  reconnect(): void {
    if (!this.started) {
      this.start();
      return;
    }
    this.replaceSubscriptions();
  }

  /** Explicitly rebase one acquired session without disturbing other domains. */
  reconnectSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) this.rebaseSession(entry);
  }

  stopShell(): void {
    this.stop();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.removeListeners();
    this.closeSubscriptions();
    this.store.setConnection('offline');
  }

  /** Acquire a session feed; the final release closes it and caches projection state. */
  acquireSession(sessionId: string): SessionSubscriptionHandle {
    if (!sessionId) throw new Error('A session ID is required.');
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = {
        id: sessionId,
        generation: 1,
        refs: 0,
        sequence: 0,
        sequenceKnown: false,
        opening: 0,
        rebasing: false,
      };
      this.sessions.set(sessionId, entry);
      this.store.beginSessionSync(sessionId, entry.generation);
    } else if (entry.refs === 0) {
      this.inactiveSessions.delete(sessionId);
      entry.generation += 1;
      entry.rebasing = false;
      this.store.beginSessionSync(sessionId, entry.generation, true);
    }
    entry.refs += 1;
    if (entry.refs === 1 && this.started) void this.openSession(entry, false);
    let released = false;
    return {
      sessionId,
      release: () => {
        if (released) return;
        released = true;
        this.releaseSession(sessionId);
      },
    };
  }

  releaseSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    entry.opening += 1;
    entry.subscription?.unsubscribe();
    entry.subscription = undefined;
    if (
      !this.store.markSessionCached(
        sessionId,
        entry.generation,
        entry.sequence,
        entry.sequenceKnown,
      )
    ) {
      this.sessions.delete(sessionId);
      this.store.evictSessionProjection(sessionId);
      return;
    }
    this.inactiveSessions.delete(sessionId);
    this.inactiveSessions.set(sessionId, true);
    while (this.inactiveSessions.size > SESSION_PROJECTION_CACHE_LIMIT) {
      const oldest = this.inactiveSessions.keys().next().value;
      if (oldest === undefined) break;
      this.inactiveSessions.delete(oldest);
      this.sessions.delete(oldest);
      this.store.evictSessionProjection(oldest);
    }
  }

  private installListeners(): void {
    if (this.listenersInstalled || typeof window === 'undefined') return;
    this.listenersInstalled = true;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private removeListeners(): void {
    if (!this.listenersInstalled || typeof window === 'undefined') return;
    this.listenersInstalled = false;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  private closeSubscriptions(): void {
    // Invalidate endpoint/client acquisition already in flight. Otherwise an
    // offline or stopped runtime can install a subscription after its awaited
    // client selection resolves.
    this.shellOpening += 1;
    this.shellSubscription?.unsubscribe();
    this.shellSubscription = undefined;
    for (const entry of this.sessions.values()) {
      entry.opening += 1;
      entry.subscription?.unsubscribe();
      entry.subscription = undefined;
    }
  }

  private replaceSubscriptions(): void {
    if (!this.started) return;
    this.closeSubscriptions();
    if (!this.isOnline()) {
      this.store.setConnection('offline');
      return;
    }
    this.store.setConnection('connecting');
    void this.openShell(false);
    for (const entry of this.sessions.values())
      if (entry.refs > 0) void this.openSession(entry, false);
  }

  private async getClient(): Promise<DashboardTrpcClient> {
    if (this.trpc) return this.trpc;
    this.trpc = await this.client.getTrpcClient();
    return this.trpc;
  }

  private resetShellDomain(): void {
    this.shellGeneration += 1;
    this.shellSequence = 0;
    this.shellSequenceKnown = false;
    this.shellSnapshotId = undefined;
    this.shellRebasing = false;
    this.store.beginShellSync(this.shellGeneration);
  }

  private async openShell(rebase: boolean): Promise<void> {
    if (!this.started || !this.isOnline()) return;
    const opening = ++this.shellOpening;
    if (rebase) this.resetShellDomain();
    try {
      const client = await this.getClient();
      if (!this.started || opening !== this.shellOpening || !this.isOnline())
        return;
      const subscription = client.shellSubscribe.subscribe(
        {},
        {
          onData: (value) => {
            if (opening !== this.shellOpening || !this.started) return;
            this.store.setConnection('connected');
            this.acceptShell(value as unknown);
          },
          onError: (error) => {
            if (opening !== this.shellOpening || !this.started) return;
            const kind = connectionErrorKind(error);
            if (kind === 'authentication' || kind === 'protocol-mismatch') {
              this.blockConnection(kind, error);
              return;
            }
            this.store.setConnection('error', messageError(error), kind);
          },
        },
      );
      if (opening !== this.shellOpening || !this.started || !this.isOnline()) {
        subscription.unsubscribe();
        return;
      }
      this.shellSubscription = subscription;
    } catch (error) {
      if (opening !== this.shellOpening || !this.started) return;
      const kind = connectionErrorKind(error);
      if (kind === 'authentication' || kind === 'protocol-mismatch')
        this.blockConnection(kind, error);
      else this.store.setConnection('error', messageError(error), kind);
    }
  }

  private acceptShell(value: unknown): void {
    const tracked = trackedValue<ShellValue>(value);
    if (!tracked.id) return;
    const payload = tracked.data;
    const sequence = numericSequence(payload);
    if (sequence === undefined) return;
    if (payload.type === 'snapshot') {
      if (tracked.id === this.shellSnapshotId) return;
      const previousServerId = this.store.getSnapshot().serverId;
      const serverChanged =
        previousServerId !== undefined &&
        payload.snapshot.snapshot.serverId !== previousServerId;
      if (serverChanged) this.resetShellDomain();
      this.shellSequence = sequence;
      this.shellSequenceKnown = true;
      this.shellSnapshotId = tracked.id;
      this.store.acceptShellSnapshot(
        payload.snapshot.snapshot,
        sequence,
        this.shellGeneration,
        true,
      );
      if (serverChanged) this.reacquireSessions();
      return;
    }
    if (isCaughtUp(payload)) {
      if (this.shellSequenceKnown && sequence < this.shellSequence) return;
      if (this.shellSequenceKnown && sequence > this.shellSequence) {
        this.rebaseShell();
        return;
      }
      this.shellSequence = sequence;
      this.shellSequenceKnown = true;
      if (this.store.getSnapshot().shellSync.status !== 'live')
        this.store.completeShellSync(sequence);
      return;
    }
    if (this.shellSequenceKnown && sequence <= this.shellSequence) return;
    if (this.shellSequenceKnown && sequence > this.shellSequence + 1) {
      this.rebaseShell();
      return;
    }
    // A contiguous shell event is the complete state transition. There is no
    // finite shellSnapshot fallback in the live path.
    if (!this.store.acceptShellEvent(payload, this.shellGeneration)) {
      this.rebaseShell();
      return;
    }
    this.shellSequence = sequence;
    this.shellSequenceKnown = true;
  }

  private reacquireSessions(): void {
    for (const entry of this.sessions.values()) {
      if (entry.refs === 0) continue;
      entry.subscription?.unsubscribe();
      entry.subscription = undefined;
      void this.openSession(entry, true);
    }
  }

  private rebaseShell(): void {
    if (this.shellRebasing || !this.started) return;
    this.shellRebasing = true;
    this.shellSubscription?.unsubscribe();
    this.shellSubscription = undefined;
    void this.openShell(true);
  }

  private async openSession(
    entry: DomainEntry,
    rebase: boolean,
  ): Promise<void> {
    if (!this.started || entry.refs === 0 || !this.isOnline()) return;
    const opening = ++entry.opening;
    if (rebase) {
      entry.generation += 1;
      entry.sequence = 0;
      entry.sequenceKnown = false;
      entry.lastEventId = undefined;
      entry.rebasing = false;
      this.store.beginSessionSync(entry.id, entry.generation);
    }
    try {
      const client = await this.getClient();
      if (
        !this.started ||
        entry.opening !== opening ||
        entry.refs === 0 ||
        !this.isOnline()
      )
        return;
      const input = {
        sessionId: entry.id,
        ...(entry.lastEventId === undefined
          ? {}
          : { lastEventId: entry.lastEventId }),
      };
      const subscription = client.sessionSubscribe.subscribe(input, {
        onData: (value) => {
          if (!this.started || entry.opening !== opening || entry.refs === 0)
            return;
          this.acceptSession(entry, value as unknown);
        },
        onError: (error) => {
          if (!this.started || entry.opening !== opening || entry.refs === 0)
            return;
          this.failSessionSubscription(entry.id, error);
        },
      });
      if (
        !this.started ||
        entry.opening !== opening ||
        entry.refs === 0 ||
        !this.isOnline()
      ) {
        subscription.unsubscribe();
        return;
      }
      entry.subscription = subscription;
    } catch (error) {
      if (!this.started || entry.opening !== opening || entry.refs === 0)
        return;
      this.failSessionSubscription(entry.id, error);
    }
  }

  private failSessionSubscription(sessionId: string, error: unknown): void {
    this.store.failSessionSync(sessionId, messageError(error));
    const kind = connectionErrorKind(error);
    if (kind === 'authentication' || kind === 'protocol-mismatch')
      this.blockConnection(kind, error);
  }

  /** Block configuration failures until the application input changes. */
  private blockConnection(
    kind: 'authentication' | 'protocol-mismatch',
    error: unknown,
  ): void {
    this.closeSubscriptions();
    this.store.setConnection('blocked', messageError(error), kind);
  }

  private acceptSession(entry: DomainEntry, value: unknown): void {
    const tracked = trackedValue<SessionValue>(value);
    if (!tracked.id) return;
    const payload = tracked.data;
    const sequence = numericSequence(payload);
    if (sequence === undefined) return;
    if (tracked.id === entry.lastEventId) return;
    if (payload.type === 'snapshot') {
      const previousServerId = this.store.getSnapshot().serverId;
      if (
        previousServerId !== undefined &&
        payload.snapshot.serverId !== previousServerId
      ) {
        // Shell authority owns daemon generation. Keep this acquired feed
        // pending while the shell subscription obtains the new authority.
        this.rebaseShell();
        return;
      }
      if (
        !this.store.acceptSessionSnapshot(
          payload.snapshot,
          sequence,
          entry.generation,
          true,
        )
      )
        return;
      entry.sequence = sequence;
      entry.sequenceKnown = true;
      entry.lastEventId = tracked.id;
      return;
    }
    if (isCaughtUp(payload)) {
      if (entry.sequenceKnown && sequence < entry.sequence) return;
      if (entry.sequenceKnown && sequence > entry.sequence) {
        this.rebaseSession(entry);
        return;
      }
      entry.sequence = sequence;
      entry.sequenceKnown = true;
      entry.lastEventId = tracked.id;
      this.store.completeSessionSync(entry.id, sequence);
      return;
    }
    if (entry.sequenceKnown && sequence <= entry.sequence) return;
    if (entry.sequenceKnown && sequence > entry.sequence + 1) {
      this.rebaseSession(entry);
      return;
    }
    if (
      !this.store.acceptSessionEvent(
        entry.id,
        sequence,
        payload,
        entry.generation,
      )
    ) {
      this.rebaseSession(entry);
      return;
    }
    entry.sequence = sequence;
    entry.sequenceKnown = true;
    entry.lastEventId = tracked.id;
  }

  private rebaseSession(entry: DomainEntry): void {
    if (entry.rebasing || !this.started || entry.refs === 0) return;
    entry.rebasing = true;
    entry.subscription?.unsubscribe();
    entry.subscription = undefined;
    void this.openSession(entry, true);
  }
}

export function createDashboardConnectionRuntime(
  options: DashboardConnectionRuntimeOptions,
): DashboardConnectionRuntime {
  return new DashboardConnectionRuntime(options);
}
