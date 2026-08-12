import type { NotificationEvent } from '@pi-dashboard/protocol';
import type { MetadataStore } from '../metadata.js';
import type { PushSender } from '../push.js';
import type { RegistryChange } from '../runtime-registry.js';

function isTranscriptEvent(change: RegistryChange): boolean {
  return (
    change.kind === 'event' &&
    (change.event.type.startsWith('message.') ||
      change.event.type.startsWith('tool.'))
  );
}

function isSessionReplacementGoodbye(change: RegistryChange): boolean {
  if (change.kind !== 'event' || change.event.type !== 'runtime.goodbye')
    return false;
  return ['new', 'resume', 'fork'].includes(change.event.reason ?? '');
}

/** Derives durable/in-app notifications from runtime changes. */
export class NotificationService {
  constructor(
    private readonly metadata: MetadataStore,
    private push: PushSender,
  ) {}

  setPush(push: PushSender): void {
    this.push = push;
  }

  shouldPersistRuntime(change: RegistryChange): boolean {
    return !isTranscriptEvent(change);
  }

  handle(change: RegistryChange): void {
    if (change.kind === 'offline') {
      const kind =
        change.snapshot.liveState === 'failed' ? 'failed' : 'runtime-exited';
      this.publish({
        id: `${kind}-${change.snapshot.runtimeId}-${change.snapshot.lastSeenAt ?? Date.now()}`,
        kind,
        runtimeId: change.snapshot.runtimeId,
        sessionId: change.snapshot.session.id,
        title:
          kind === 'failed'
            ? 'Pi runtime failed'
            : 'Pi runtime disconnected unexpectedly',
        body:
          change.snapshot.lastError ??
          change.snapshot.session.name ??
          change.snapshot.cwd,
        createdAt: Date.now(),
      });
      return;
    }
    if (change.kind !== 'event') return;
    const event = change.event;
    if (event.type === 'interaction.resolved') {
      this.metadata.clearWaitingNotifications(change.snapshot.runtimeId);
      void this.push
        .clearWaiting?.(change.snapshot.runtimeId)
        .catch(() => undefined);
    }
    const shouldNotify =
      event.type === 'interaction.requested' ||
      (event.type === 'runtime.goodbye' &&
        !isSessionReplacementGoodbye(change)) ||
      (event.type === 'agent.settled' &&
        process.env.PI_DASHBOARD_NOTIFY_SETTLED === '1');
    if (!shouldNotify) return;
    this.publish({
      id: `${event.type}-${change.snapshot.runtimeId}-${event.type === 'interaction.requested' ? event.interaction.id : Date.now()}`,
      kind:
        event.type === 'interaction.requested'
          ? 'waiting'
          : event.type === 'agent.settled'
            ? 'settled'
            : 'runtime-exited',
      runtimeId: change.snapshot.runtimeId,
      sessionId: change.snapshot.session.id,
      title:
        event.type === 'interaction.requested'
          ? 'Pi is waiting for an answer'
          : event.type === 'agent.settled'
            ? 'Pi finished a turn'
            : 'Pi runtime exited',
      body:
        event.type === 'interaction.requested'
          ? event.interaction.question
          : (change.snapshot.session.name ?? change.snapshot.cwd),
      createdAt: Date.now(),
    });
  }

  close(): void {
    this.push.close?.();
  }

  private publish(notification: NotificationEvent): void {
    this.metadata.addNotification(notification);
    void this.push.notify(notification).catch(() => undefined);
  }
}
