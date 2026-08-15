import type {
  AuthoritativeSessionSnapshot,
  BridgeEvent,
  SessionFeedEvent,
  ShellFeedData,
  ShellFeedDomain,
  ShellFeedEvent,
  ShellSnapshotResponse,
} from '@pi-dashboard/protocol';
import { projectShellInteraction } from './application/dashboard-application.js';
import { BoundedFeed, type FeedBounds, type FeedMetrics } from './live-feed.js';

export interface LiveFeedOptions extends FeedBounds {
  readonly generation?: string;
}

const MAX_DIAGNOSTIC_SESSION_FEEDS = 4_096;

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
    data: ShellFeedData,
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
      } as ShellFeedEvent,
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

  invalidate(sessionId: string): void {
    const feed = this.feeds.get(sessionId);
    if (!feed) return;
    feed.close();
    this.feeds.delete(sessionId);
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

  metrics(
    limit = MAX_DIAGNOSTIC_SESSION_FEEDS,
  ): readonly (FeedMetrics & { sessionId: string; active: boolean })[] {
    const result: (FeedMetrics & { sessionId: string; active: boolean })[] = [];
    for (const feed of this.feeds.values()) {
      if (result.length >= limit) result.shift();
      result.push({
        ...feed.metrics(),
        sessionId: feed.sessionId,
        active: feed.active,
      });
    }
    return result;
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
): 'interaction' | undefined {
  switch (event.type) {
    case 'interaction.requested':
    case 'interaction.resolved':
      return 'interaction';
    default:
      // Message, tool, and delegate transcript activity is session-feed only.
      // Runtime shell changes are detected from the compact runtime snapshot.
      return undefined;
  }
}

export function compactShellEventData(
  event: BridgeEvent,
  runtimeId: string,
): Extract<ShellFeedData, { kind: string }> {
  switch (event.type) {
    case 'interaction.requested':
      return {
        kind: 'upsert',
        runtimeId,
        interaction: projectShellInteraction(event.interaction),
      } as Extract<ShellFeedData, { kind: 'upsert'; interaction: unknown }>;
    case 'interaction.resolved':
      return {
        kind: 'remove',
        runtimeId,
        interactionId: event.interactionId,
      };
    default:
      throw new Error(`Event ${event.type} has no shell patch.`);
  }
}
