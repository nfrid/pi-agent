import type { TranscriptProjection } from '@pi-dashboard/domain';
import {
  type NotificationEvent,
  RESPONSE_CLOSURE_MARKER_TYPE,
  tryParseResponseClosure,
} from '@pi-dashboard/protocol';
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

const SETTLED_BODY_LIMIT = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finalAssistantText(
  change: Extract<RegistryChange, { kind: 'event' }>,
  projection?: TranscriptProjection,
): string {
  const closure =
    change.event.type === 'agent.settled' ? change.event.closure : undefined;
  if (
    closure?.type !== 'custom' ||
    closure.customType !== RESPONSE_CLOSURE_MARKER_TYPE
  )
    return '';
  const data = tryParseResponseClosure(closure.data);
  if (!data) return '';

  const messageIds = [data.liveFinalMessageId, data.finalMessageId].filter(
    (id): id is string => id !== undefined,
  );
  const liveMessage = projection
    ? messageIds
        .map((id) => projection.items[id])
        .find((item) => item?.kind === 'message' && item.role === 'assistant')
    : undefined;
  const persistedEntry = liveMessage
    ? undefined
    : change.snapshot.session.entries.find((candidate) => {
        if (!isRecord(candidate)) return false;
        const message = isRecord(candidate.message)
          ? candidate.message
          : candidate;
        return (
          messageIds.some(
            (id) =>
              candidate.id === id ||
              message.id === id ||
              message.messageId === id,
          ) && message.role === 'assistant'
        );
      });
  const message = isRecord(persistedEntry)
    ? isRecord(persistedEntry.message)
      ? persistedEntry.message
      : persistedEntry
    : undefined;
  if (!liveMessage && !message) return '';
  const content =
    liveMessage?.kind === 'message' ? liveMessage.content : message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((part) =>
              isRecord(part) &&
              part.type === 'text' &&
              typeof part.text === 'string'
                ? [part.text]
                : [],
            )
            .join(' ')
        : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, SETTLED_BODY_LIMIT);
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function settledNotificationTitle(
  metadata: MetadataStore,
  snapshot: Extract<RegistryChange, { kind: 'event' }>['snapshot'],
): string {
  const link = metadata.orchestration.getSessionThreadLink(snapshot.session.id);
  const thread = link
    ? metadata.orchestration.getThread(link.threadId)
    : undefined;
  const project = snapshot.projectId
    ? metadata.orchestration.getProject(snapshot.projectId)
    : undefined;
  const displayName =
    nonBlank(thread?.title) ??
    nonBlank(snapshot.session.name) ??
    nonBlank(snapshot.session.title);
  const projectName = nonBlank(project?.title);
  if (!displayName && !projectName) return 'Pi finished a turn';
  if (!displayName) return projectName?.slice(0, 512) ?? 'Pi finished a turn';
  if (!projectName) return displayName.slice(0, 512);

  const separator = ' · ';
  const projectLimit = Math.max(0, 512 - separator.length - displayName.length);
  if (projectLimit === 0) return displayName.slice(0, 512);
  return `${projectName.slice(0, projectLimit).trimEnd()}${separator}${displayName}`;
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

  handle(change: RegistryChange, projection?: TranscriptProjection): void {
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
    }
    if (change.kind !== 'event') return;
    const event = change.event;
    const failedGoodbye =
      event.type === 'runtime.goodbye' &&
      change.snapshot.liveState === 'failed';
    const shouldNotify =
      failedGoodbye ||
      (event.type === 'agent.settled' &&
        process.env.PI_DASHBOARD_NOTIFY_SETTLED === '1');
    if (!shouldNotify) return;
    this.publish({
      id: `${failedGoodbye ? 'failed' : event.type}-${change.snapshot.runtimeId}-${Date.now()}`,
      kind: failedGoodbye ? 'failed' : 'settled',
      runtimeId: change.snapshot.runtimeId,
      sessionId: change.snapshot.session.id,
      title: failedGoodbye
        ? 'Pi runtime failed'
        : settledNotificationTitle(this.metadata, change.snapshot),
      body: failedGoodbye
        ? (change.snapshot.lastError ??
          change.snapshot.session.name ??
          change.snapshot.cwd)
        : finalAssistantText(change, projection) || 'Turn completed.',
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
