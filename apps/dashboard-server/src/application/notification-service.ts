import type { TranscriptProjection } from '@pi-dashboard/domain';
import {
  type NotificationEvent,
  RESPONSE_CLOSURE_MARKER_TYPE,
  tryParseResponseClosure,
} from '@pi-dashboard/protocol';
import { decodeHTML } from 'entities';
import { parseDocument } from 'htmlparser2';
import { marked, type Tokens, type TokensList } from 'marked';
import type { MetadataStore } from '../metadata.js';
import { notificationUrl, type PushSender } from '../push.js';
import type { RegistryChange } from '../runtime-registry.js';

function isTranscriptEvent(change: RegistryChange): boolean {
  return (
    change.kind === 'event' &&
    (change.event.type.startsWith('message.') ||
      change.event.type.startsWith('tool.'))
  );
}

const SETTLED_BODY_LIMIT = 240;

type MarkdownToken = TokensList[number];

type HtmlNode = ReturnType<typeof parseDocument>['children'][number];

function htmlText(nodes: readonly HtmlNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.data;
      if (node.type === 'tag' && node.name === 'br') return '\n';
      return 'children' in node ? htmlText(node.children) : '';
    })
    .join('');
}

function markdownTokensText(tokens: readonly MarkdownToken[]): string {
  return tokens
    .map((token) => {
      const children =
        'tokens' in token && token.tokens
          ? markdownTokensText(token.tokens)
          : '';
      switch (token.type) {
        case 'space':
          return '\n';
        case 'paragraph':
        case 'heading':
          return `${children}\n`;
        case 'code':
          return `${(token as Tokens.Code).text}\n`;
        case 'codespan':
          return (token as Tokens.Codespan).text;
        case 'text':
          return token.tokens ? children : decodeHTML(token.text);
        case 'escape':
          return decodeHTML(token.text);
        case 'html': {
          const html = token as Tokens.HTML;
          const text = htmlText(parseDocument(html.text).children);
          return html.block ? `${text}\n` : text;
        }
        case 'blockquote':
          return `${children}\n`;
        case 'list': {
          const list = token as Tokens.List;
          return `${list.items
            .map(
              (item, index) =>
                `${list.ordered ? `${Number(list.start || 1) + index}. ` : '• '}${markdownTokensText(item.tokens)}`,
            )
            .join('\n')}\n`;
        }
        case 'list_item':
          return children || (token as Tokens.ListItem).text;
        case 'table': {
          const table = token as Tokens.Table;
          return `${[table.header, ...table.rows]
            .map((row) =>
              row.map((cell) => markdownTokensText(cell.tokens)).join(' | '),
            )
            .join('\n')}\n`;
        }
        case 'br':
        case 'hr':
          return '\n';
        case 'image':
          return children || (token as Tokens.Image).text;
        default:
          return children || ('text' in token ? decodeHTML(token.text) : '');
      }
    })
    .join('');
}

function markdownPlainText(markdown: string): string {
  return markdownTokensText(marked.lexer(markdown));
}

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
  return markdownPlainText(text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SETTLED_BODY_LIMIT);
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function notificationNames(
  metadata: MetadataStore,
  snapshot: Extract<RegistryChange, { kind: 'event' }>['snapshot'],
): { project: string; thread: string; title: string } {
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
  const names = {
    project: projectName?.slice(0, 512) ?? 'Pi',
    thread: displayName?.slice(0, 512) ?? 'Thread',
  };
  if (!displayName && !projectName)
    return { ...names, title: 'Pi finished a turn' };
  if (!displayName)
    return {
      ...names,
      title: projectName?.slice(0, 512) ?? 'Pi finished a turn',
    };
  if (!projectName) return { ...names, title: displayName.slice(0, 512) };
  const separator = ' · ';
  const projectLimit = Math.max(0, 512 - separator.length - displayName.length);
  return {
    ...names,
    title:
      projectLimit === 0
        ? displayName.slice(0, 512)
        : `${projectName.slice(0, projectLimit).trimEnd()}${separator}${displayName}`,
  };
}

/** Derives durable/in-app notifications from runtime changes. */
export class NotificationService {
  constructor(
    private readonly metadata: MetadataStore,
    private push: PushSender,
    private readonly isDelegateSession: (
      snapshot: Extract<RegistryChange, { kind: 'event' }>['snapshot'],
    ) => boolean = () => false,
  ) {}

  setPush(push: PushSender): void {
    this.push = push;
  }

  shouldPersistRuntime(change: RegistryChange): boolean {
    return !isTranscriptEvent(change);
  }

  handle(change: RegistryChange, projection?: TranscriptProjection): void {
    if (change.kind === 'offline') {
      const names = notificationNames(this.metadata, change.snapshot);
      const kind =
        change.snapshot.liveState === 'failed' ? 'failed' : 'runtime-exited';
      this.publish(
        {
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
        },
        names,
      );
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
    if (
      event.type === 'agent.settled' &&
      this.isDelegateSession(change.snapshot)
    )
      return;
    const names = notificationNames(this.metadata, change.snapshot);
    this.publish(
      {
        id: `${failedGoodbye ? 'failed' : event.type}-${change.snapshot.runtimeId}-${Date.now()}`,
        kind: failedGoodbye ? 'failed' : 'settled',
        runtimeId: change.snapshot.runtimeId,
        sessionId: change.snapshot.session.id,
        title: failedGoodbye ? 'Pi runtime failed' : names.title,
        body: failedGoodbye
          ? (change.snapshot.lastError ??
            change.snapshot.session.name ??
            change.snapshot.cwd)
          : finalAssistantText(change, projection) || 'Turn completed.',
        createdAt: Date.now(),
      },
      names,
    );
  }

  close(): void {
    this.push.close?.();
  }

  private publish(
    notification: NotificationEvent,
    names: { project: string; thread: string },
  ): void {
    this.metadata.addNotification(notification);
    void this.push
      .notify(notification, {
        project: names.project,
        thread: names.thread,
        url: notificationUrl(notification, 'native'),
      })
      .catch(() => undefined);
  }
}
