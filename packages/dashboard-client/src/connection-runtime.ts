import type {
  FeedCaughtUp,
  SessionFeedMessage,
  ShellFeedEvent,
  ShellFeedMessage,
} from '@pi-dashboard/protocol';
import type { DashboardTokenStore } from './authentication.js';
import type { FetchLike } from './http-client.js';
import { DashboardHttpClient, DashboardHttpError } from './http-client.js';
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
  eventOrder: number;
  sequenceKnown: boolean;
  lastEventId?: FeedCursorValue;
  seen: Set<string>;
  subscription?: Subscription;
  opening: number;
  rebasing: boolean;
};

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
  )
    return value as { id: string; data: T };
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

function isAuthenticationError(error: unknown): boolean {
  if (error instanceof DashboardHttpError)
    return error.status === 401 || error.status === 403;
  const code =
    error && typeof error === 'object' && 'data' in error
      ? (error as { data?: { code?: unknown } }).data?.code
      : undefined;
  return code === 'UNAUTHORIZED' || code === 'FORBIDDEN';
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
  private shellLastEventId?: FeedCursorValue;
  private shellSeen = new Set<string>();
  private shellOpening = 0;
  private shellSubscription?: Subscription;
  private shellRebasing = false;
  private shellRefresh?: Promise<void>;
  private sessions = new Map<string, DomainEntry>();
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

  /** Acquire a session feed; the final release closes that feed immediately. */
  acquireSession(sessionId: string): SessionSubscriptionHandle {
    if (!sessionId) throw new Error('A session ID is required.');
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = {
        id: sessionId,
        generation: 1,
        refs: 0,
        sequence: 0,
        eventOrder: 0,
        sequenceKnown: true,
        seen: new Set(),
        opening: 0,
        rebasing: false,
      };
      this.sessions.set(sessionId, entry);
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
    entry.subscription?.unsubscribe();
    entry.subscription = undefined;
    this.sessions.delete(sessionId);
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
    this.shellSubscription?.unsubscribe();
    this.shellSubscription = undefined;
    for (const entry of this.sessions.values()) {
      entry.subscription?.unsubscribe();
      entry.subscription = undefined;
    }
  }

  private replaceSubscriptions(): void {
    if (!this.started || !this.isOnline()) return;
    this.closeSubscriptions();
    this.store.setConnection('connecting');
    void this.openShell(false, this.shellLastEventId);
    for (const entry of this.sessions.values())
      if (entry.refs > 0)
        void this.openSession(entry, false, entry.lastEventId);
  }

  private async getClient(): Promise<DashboardTrpcClient> {
    if (this.trpc) return this.trpc;
    this.trpc = await this.client.getTrpcClient();
    return this.trpc;
  }

  private async openShell(rebase: boolean, after?: string): Promise<void> {
    if (!this.started || !this.isOnline()) return;
    const opening = ++this.shellOpening;
    if (rebase) {
      this.shellGeneration += 1;
      this.shellSequence = 0;
      this.shellLastEventId = undefined;
      this.shellSeen = new Set();
      this.shellRebasing = false;
      this.store.beginShellSync(this.shellGeneration);
    }
    try {
      const client = await this.getClient();
      if (!this.started || opening !== this.shellOpening) return;
      const input = after ? { lastEventId: after } : {};
      const subscription = client.shellSubscribe.subscribe(input, {
        onData: (value) => {
          if (opening !== this.shellOpening || !this.started) return;
          this.store.setConnection('connected');
          this.acceptShell(value as unknown);
        },
        onError: (error) => {
          if (opening !== this.shellOpening || !this.started) return;
          if (isAuthenticationError(error)) {
            this.store.setConnection('blocked', messageError(error));
            return;
          }
          this.store.setConnection('error', messageError(error));
        },
      });
      if (opening !== this.shellOpening || !this.started) {
        subscription.unsubscribe();
        return;
      }
      this.shellSubscription = subscription;
    } catch (error) {
      if (opening !== this.shellOpening || !this.started) return;
      this.store.setConnection(
        isAuthenticationError(error) ? 'blocked' : 'error',
        messageError(error),
      );
    }
  }

  private acceptShell(value: unknown): void {
    const tracked = trackedValue<ShellValue>(value);
    if (tracked.id && this.shellSeen.has(tracked.id)) return;
    const payload = tracked.data;
    const sequence = numericSequence(payload);
    if (sequence !== undefined) {
      if (isCaughtUp(payload) && sequence === this.shellSequence) {
        this.shellLastEventId = tracked.id ?? this.shellLastEventId;
        this.store.completeShellSync(sequence, tracked.id);
        return;
      }
      if (sequence <= this.shellSequence) return;
      if (this.shellSequence > 0 && sequence > this.shellSequence + 1) {
        this.rebaseShell();
        return;
      }
      this.shellSequence = sequence;
    }
    if (tracked.id) {
      this.shellSeen.add(tracked.id);
      this.shellLastEventId = tracked.id;
    }
    if (payload.type === 'snapshot') {
      this.store.acceptShellSnapshot(
        payload.snapshot.snapshot,
        payload.sequence,
        this.shellGeneration,
        tracked.id,
      );
      return;
    }
    if (payload.type === 'caught-up') {
      this.store.completeShellSync(payload.sequence, tracked.id);
      return;
    }
    void this.refreshShell(payload);
  }

  private async refreshShell(event: ShellFeedEvent): Promise<void> {
    if (this.shellRefresh) return this.shellRefresh;
    this.shellRefresh = this.client
      .snapshot()
      .then((snapshot) => {
        if (this.started)
          this.store.acceptShellSnapshot(
            snapshot,
            this.shellSequence,
            this.shellGeneration,
            this.shellLastEventId,
          );
      })
      .catch((error) => {
        if (this.started) this.store.failShellSync(messageError(error));
      })
      .finally(() => {
        this.shellRefresh = undefined;
      });
    void event;
    return this.shellRefresh;
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
    after?: string,
  ): Promise<void> {
    if (!this.started || entry.refs === 0 || !this.isOnline()) return;
    const opening = ++entry.opening;
    if (rebase) {
      entry.generation += 1;
      entry.sequence = 0;
      entry.eventOrder = 0;
      entry.sequenceKnown = true;
      entry.lastEventId = undefined;
      entry.seen = new Set();
      entry.rebasing = false;
      this.store.beginSessionSync(entry.id, entry.generation);
    }
    try {
      const client = await this.getClient();
      if (!this.started || entry.opening !== opening || entry.refs === 0)
        return;
      const input = {
        sessionId: entry.id,
        ...(after ? { lastEventId: after } : {}),
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
          this.store.failSessionSync(entry.id, messageError(error));
        },
      });
      if (!this.started || entry.opening !== opening || entry.refs === 0) {
        subscription.unsubscribe();
        return;
      }
      entry.subscription = subscription;
    } catch (error) {
      if (!this.started || entry.refs === 0) return;
      this.store.failSessionSync(entry.id, messageError(error));
    }
  }

  private acceptSession(entry: DomainEntry, value: unknown): void {
    const tracked = trackedValue<SessionValue>(value);
    if (tracked.id && entry.seen.has(tracked.id)) return;
    const payload = tracked.data;
    const sequence = numericSequence(payload);
    if (sequence !== undefined) {
      if (isCaughtUp(payload)) {
        if (entry.sequenceKnown && sequence < entry.sequence) return;
        entry.sequence = sequence;
        entry.eventOrder = sequence;
        entry.sequenceKnown = true;
        entry.lastEventId = tracked.id ?? entry.lastEventId;
        this.store.completeSessionSync(entry.id, sequence, tracked.id);
        return;
      }
      if (entry.sequenceKnown && sequence <= entry.sequence) return;
      if (
        entry.sequenceKnown &&
        entry.sequence > 0 &&
        sequence > entry.sequence + 1
      ) {
        this.rebaseSession(entry);
        return;
      }
      entry.sequence = sequence;
      entry.eventOrder = sequence;
      entry.sequenceKnown = true;
    } else if (!tracked.id) {
      // Untracked values are not expected from the production link. Refuse
      // them rather than accepting a record that cannot be resumed safely.
      return;
    } else {
      // Session event payloads intentionally carry runtime ordering, while the
      // feed sequence remains opaque in the tracked ID. Use arrival order only
      // for reducer ordering; the tracked ID remains the sole resume cursor.
      entry.eventOrder += 1;
      entry.sequenceKnown = false;
    }
    if (tracked.id) {
      entry.seen.add(tracked.id);
      entry.lastEventId = tracked.id;
    }
    if (payload.type === 'snapshot') {
      this.store.acceptSessionSnapshot(
        payload.snapshot,
        payload.sequence,
        entry.generation,
        tracked.id,
      );
      return;
    }
    if (payload.type === 'caught-up') {
      this.store.completeSessionSync(entry.id, payload.sequence, tracked.id);
      return;
    }
    this.store.acceptSessionEvent(
      entry.id,
      entry.eventOrder,
      payload,
      entry.generation,
    );
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
