import type {
  AuthoritativeSessionSnapshot,
  BridgeEvent,
  SessionFeedEvent,
  ShellFeedDomain,
  ShellFeedEvent,
  ShellSnapshotResponse,
} from '@pi-dashboard/protocol';
import { BoundedFeed, type FeedBounds, type FeedMetrics } from './live-feed.js';

export interface LiveFeedOptions extends FeedBounds {
  readonly generation?: string;
}

const DEFAULT_BOUNDS: FeedBounds = {
  replayCount: 256,
  replayBytes: 4 * 1024 * 1024,
  subscriberQueueCount: 128,
  subscriberQueueBytes: 4 * 1024 * 1024,
  maxFrameBytes: 2 * 1024 * 1024,
};

export class ShellFeed extends BoundedFeed<
  ShellSnapshotResponse,
  ShellFeedEvent
> {
  constructor(options: Partial<LiveFeedOptions> = {}) {
    const { generation: _generation, ...bounds } = options;
    super('shell', { ...DEFAULT_BOUNDS, ...bounds }, options.generation);
  }

  publishSemantic(
    domain: ShellFeedDomain,
    revision: number,
    data: unknown,
    sessionId?: string,
    key?: string,
  ): void {
    this.publish(
      {
        type: 'shell-event',
        sequence: this.sequence + 1,
        domain,
        revision,
        ...(sessionId === undefined ? {} : { sessionId }),
        data,
      },
      key === undefined ? {} : { key },
    );
  }
}

export class SessionFeed extends BoundedFeed<
  AuthoritativeSessionSnapshot,
  SessionFeedEvent
> {
  readonly sessionId: string;
  lastPublishedAt = Date.now();
  active = false;

  constructor(sessionId: string, options: Partial<LiveFeedOptions> = {}) {
    const { generation: _generation, ...bounds } = options;
    super(
      `session-${Buffer.from(sessionId, 'utf8').toString('base64url')}`,
      { ...DEFAULT_BOUNDS, ...bounds },
      options.generation,
    );
    this.sessionId = sessionId;
  }

  publishEvent(
    event: BridgeEvent,
    metadata: Omit<
      SessionFeedEvent,
      'type' | 'sessionId' | 'event' | 'sequence'
    > = {},
    key?: string,
  ): void {
    this.lastPublishedAt = Date.now();
    this.publish(
      {
        type: 'session-event',
        sequence: this.sequence + 1,
        sessionId: this.sessionId,
        event: event as SessionFeedEvent['event'],
        ...metadata,
      },
      key === undefined ? {} : { key },
    );
  }
}

/** Lazily creates feeds on publication as well as subscription. */
export class SessionFeedRegistry {
  private readonly feeds = new Map<string, SessionFeed>();
  private readonly options: Partial<LiveFeedOptions>;

  constructor(options: Partial<LiveFeedOptions> = {}) {
    this.options = options;
  }

  get(sessionId: string): SessionFeed {
    let feed = this.feeds.get(sessionId);
    if (!feed) {
      feed = new SessionFeed(sessionId, this.options);
      this.feeds.set(sessionId, feed);
    }
    feed.lastPublishedAt = Date.now();
    return feed;
  }

  publish(
    sessionId: string,
    event: BridgeEvent,
    metadata: Omit<
      SessionFeedEvent,
      'type' | 'sessionId' | 'event' | 'sequence'
    > = {},
    key?: string,
  ): void {
    this.get(sessionId).publishEvent(event, metadata, key);
  }

  setActive(sessionId: string, active: boolean): void {
    // An active runtime must pin a feed even before its first publication;
    // inactive lifecycle updates must not create idle feeds just to discard
    // them later.
    const feed = active ? this.get(sessionId) : this.feeds.get(sessionId);
    if (feed) feed.active = active;
  }

  /** Never removes a live feed; inactive feeds are discarded only after a bounded idle window. */
  sweep(now = Date.now(), maxInactiveMs = 15 * 60_000): number {
    let removed = 0;
    for (const [sessionId, feed] of this.feeds) {
      if (
        !feed.active &&
        feed.metrics().subscribers === 0 &&
        now - feed.lastPublishedAt >= maxInactiveMs
      ) {
        feed.close();
        this.feeds.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  metrics(): readonly (FeedMetrics & { sessionId: string; active: boolean })[] {
    return [...this.feeds.values()].map((feed) => ({
      ...feed.metrics(),
      sessionId: feed.sessionId,
      active: feed.active,
    }));
  }

  close(): void {
    for (const feed of this.feeds.values()) feed.close();
    this.feeds.clear();
  }
}

export function sessionFeedKey(event: BridgeEvent): string | undefined {
  switch (event.type) {
    case 'session.changed':
    case 'session.snapshot':
      return `session:${event.session.id}`;
    default:
      return undefined;
  }
}

/** Only compact semantic state may cross the shell feed. */
export function shellDomainForEvent(
  event: BridgeEvent,
): ShellFeedDomain | undefined {
  switch (event.type) {
    case 'message.started':
    case 'message.updated':
    case 'message.finished':
    case 'tool.started':
    case 'tool.updated':
    case 'tool.finished':
    case 'delegate.transcript.updated':
      return undefined;
    case 'interaction.requested':
    case 'interaction.resolved':
      return 'interaction';
    case 'runtime.hello':
    case 'runtime.goodbye':
    case 'runtime.stateChanged':
    case 'runtime.heartbeat':
    case 'agent.settled':
      return 'runtime';
    case 'session.changed':
    case 'session.snapshot':
    case 'session.compacted':
      return 'session-index';
    default:
      return undefined;
  }
}

export function compactShellEventData(event: BridgeEvent): unknown {
  switch (event.type) {
    case 'runtime.hello':
      return {
        runtimeId: event.snapshot.runtimeId,
        liveState: event.snapshot.liveState,
      };
    case 'runtime.goodbye':
      return { reason: event.reason };
    case 'runtime.stateChanged':
    case 'runtime.heartbeat':
      return { state: event.state };
    case 'interaction.requested':
      return { interactionId: event.interaction.id };
    case 'interaction.resolved':
      return { interactionId: event.interactionId };
    case 'agent.settled':
      return { settled: true };
    case 'session.changed':
    case 'session.snapshot':
      return { sessionId: event.session.id };
    case 'session.compacted':
      return { sessionId: event.sessionId };
    default:
      return { changed: true };
  }
}
