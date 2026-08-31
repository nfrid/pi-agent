import { dashboardHttpClient } from '@pi-dashboard/client';
import type { SessionBranchPoint } from '@pi-dashboard/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DashboardTime } from '../../features/timestamp';
import { copyText, Markdown } from '../../Markdown';
import { formatCompactCount } from '../../shared/lib/format';
import type { TranscriptModelItem } from '../../transcript';
import {
  type ActivityStepParts,
  activityStepParts,
  commandStepMeta,
} from './activity';
import { TranscriptDisclosureIcon } from './disclosure-icon';
import { BoundedPayloadPreview, ToolInspector } from './inspector';
import { transcriptItemTimestamp } from './landmarks';

interface ThumbnailState {
  source?: string;
  status: 'loading' | 'ready' | 'error';
}

function imageIndexKey(
  images: NonNullable<TranscriptModelItem['images']>,
): string {
  return images
    .filter((image) => image.available)
    .map((image) => image.index)
    .join(',');
}

function TranscriptImageGallery({
  sessionId,
  entryId,
  imageIndices,
  messageTimestamp,
}: {
  sessionId: string;
  entryId: string;
  imageIndices: string;
  messageTimestamp?: number | string;
}) {
  const images = useMemo(
    () =>
      imageIndices
        .split(',')
        .map((index) => ({ index: Number.parseInt(index, 10) })),
    [imageIndices],
  );
  const [thumbnails, setThumbnails] = useState<Record<number, ThumbnailState>>(
    {},
  );
  const [activePosition, setActivePosition] = useState<number>();
  const [fullImages, setFullImages] = useState<Record<number, ThumbnailState>>(
    {},
  );
  const fullCache = useRef({
    controllers: new Set<AbortController>(),
    objectUrls: new Set<string>(),
  });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerStart = useRef<{ id: number; x: number; y: number } | undefined>(
    undefined,
  );
  const activeImage =
    activePosition === undefined ? undefined : images[activePosition];
  const activeFull = activeImage ? fullImages[activeImage.index] : undefined;

  useEffect(() => {
    const controller = new AbortController();
    const objectUrls: string[] = [];
    const retries: ReturnType<typeof setTimeout>[] = [];
    setThumbnails({});
    for (const image of images) {
      let attempts = 0;
      const load = async () => {
        attempts += 1;
        try {
          const blob = await dashboardHttpClient.sessionImage(
            sessionId,
            entryId,
            image.index,
            {
              signal: controller.signal,
              variant: 'thumbnail',
              messageTimestamp,
            },
          );
          if (controller.signal.aborted) return;
          const source = URL.createObjectURL(blob);
          objectUrls.push(source);
          setThumbnails((current) => ({
            ...current,
            [image.index]: { source, status: 'ready' },
          }));
        } catch {
          if (controller.signal.aborted) return;
          if (attempts < 70) {
            retries.push(
              setTimeout(() => void load(), attempts < 10 ? 300 : 1_000),
            );
          } else {
            setThumbnails((current) => ({
              ...current,
              [image.index]: { status: 'error' },
            }));
          }
        }
      };
      void load();
    }
    return () => {
      controller.abort();
      for (const retry of retries) clearTimeout(retry);
      for (const source of objectUrls) URL.revokeObjectURL(source);
    };
  }, [entryId, images, messageTimestamp, sessionId]);

  useEffect(() => {
    if (activePosition === undefined) {
      if (dialogRef.current?.open) dialogRef.current.close();
      return;
    }
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, [activePosition]);

  useEffect(() => {
    const cache = fullCache.current;
    return () => {
      for (const controller of cache.controllers) controller.abort();
      for (const source of cache.objectUrls) URL.revokeObjectURL(source);
      cache.controllers.clear();
      cache.objectUrls.clear();
    };
  }, []);

  useEffect(() => {
    if (!activeImage || fullImages[activeImage.index]) return;
    const controller = new AbortController();
    const cache = fullCache.current;
    cache.controllers.add(controller);
    setFullImages((current) => ({
      ...current,
      [activeImage.index]: { status: 'loading' },
    }));
    void dashboardHttpClient
      .sessionImage(sessionId, entryId, activeImage.index, {
        signal: controller.signal,
        messageTimestamp,
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        const source = URL.createObjectURL(blob);
        cache.objectUrls.add(source);
        setFullImages((current) => ({
          ...current,
          [activeImage.index]: { source, status: 'ready' },
        }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setFullImages((current) => ({
            ...current,
            [activeImage.index]: { status: 'error' },
          }));
      })
      .finally(() => cache.controllers.delete(controller));
  }, [activeImage, entryId, fullImages, messageTimestamp, sessionId]);

  const closeViewer = () => {
    setActivePosition(undefined);
    dialogRef.current?.close();
  };
  const move = (delta: number) => {
    setActivePosition((current) =>
      current === undefined
        ? current
        : (current + delta + images.length) % images.length,
    );
  };
  const finishSwipe = (pointerId: number, x: number, y: number) => {
    const start = pointerStart.current;
    pointerStart.current = undefined;
    if (!start || start.id !== pointerId) return;
    const deltaX = x - start.x;
    const deltaY = y - start.y;
    if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 50) return;
    if (images.length === 1 || Math.abs(deltaY) > Math.abs(deltaX)) {
      closeViewer();
      return;
    }
    move(deltaX < 0 ? 1 : -1);
  };

  return (
    <fieldset className="message-images">
      <legend className="sr-only">Image attachments</legend>
      {images.map((image, position) => {
        const thumbnail = thumbnails[image.index] ?? { status: 'loading' };
        const label = `Open attached image ${position + 1}`;
        return (
          <button
            type="button"
            className="message-image-thumbnail"
            aria-label={
              thumbnail.status === 'loading'
                ? `Loading attachment ${position + 1}`
                : thumbnail.status === 'error'
                  ? `Attachment ${position + 1} unavailable`
                  : label
            }
            aria-busy={thumbnail.status === 'loading'}
            disabled={thumbnail.status !== 'ready'}
            key={image.index}
            onClick={() => setActivePosition(position)}
          >
            {thumbnail.source ? (
              <img src={thumbnail.source} alt={`Attachment ${position + 1}`} />
            ) : (
              <span
                className={`message-image-thumbnail-state state-${thumbnail.status}`}
                aria-hidden="true"
              >
                {thumbnail.status === 'error' ? '!' : ''}
              </span>
            )}
          </button>
        );
      })}
      <dialog
        ref={dialogRef}
        className="message-image-dialog"
        aria-label={
          activePosition === undefined
            ? 'Attached image viewer'
            : `Attached image ${activePosition + 1} of ${images.length}`
        }
        onClose={() => setActivePosition(undefined)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeViewer();
        }}
        onPointerDown={(event) => {
          if (
            event.pointerType !== 'touch' ||
            (event.target as Element).closest('button')
          )
            return;
          pointerStart.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
        }}
        onPointerUp={(event) =>
          finishSwipe(event.pointerId, event.clientX, event.clientY)
        }
        onPointerCancel={() => {
          pointerStart.current = undefined;
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' && images.length > 1) move(-1);
          if (event.key === 'ArrowRight' && images.length > 1) move(1);
        }}
      >
        <button
          type="button"
          className="message-image-close"
          aria-label="Close image viewer"
          onClick={closeViewer}
        >
          ×
        </button>
        {images.length > 1 ? (
          <>
            <button
              type="button"
              className="message-image-nav previous"
              aria-label="Previous attached image"
              onClick={() => move(-1)}
            >
              ‹
            </button>
            <button
              type="button"
              className="message-image-nav next"
              aria-label="Next attached image"
              onClick={() => move(1)}
            >
              ›
            </button>
            <span className="message-image-position" aria-live="polite">
              {(activePosition ?? 0) + 1} / {images.length}
            </span>
          </>
        ) : null}
        {activeImage ? (
          <img
            src={
              activeFull?.source ??
              thumbnails[activeImage.index]?.source ??
              undefined
            }
            alt={`Attachment ${(activePosition ?? 0) + 1}, expanded`}
          />
        ) : null}
        {activeFull?.status === 'loading' ? (
          <span className="message-image-loading" role="status">
            Loading full image…
          </span>
        ) : activeFull?.status === 'error' ? (
          <span className="message-image-loading" role="status">
            Full image unavailable
          </span>
        ) : null}
      </dialog>
    </fieldset>
  );
}

export function AssistantMessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const label = copied ? 'Copied assistant message' : 'Copy assistant message';
  return (
    <button
      type="button"
      className="assistant-message-copy"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await copyText(text);
          setCopied(true);
        } catch {
          // Clipboard permission can be denied without affecting the transcript.
        }
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16">
        {copied ? (
          <path d="m3 8 3 3 7-7" />
        ) : (
          <>
            <rect x="5" y="5" width="8" height="8" rx="1" />
            <path d="M3 11H2V3a1 1 0 0 1 1-1h8v1" />
          </>
        )}
      </svg>
    </button>
  );
}

export function ThinkingBlob({
  content,
  timestamp,
}: {
  content: string;
  timestamp?: number | string;
}) {
  return (
    <div className="transcript-thinking-blob">
      <DashboardTime
        className="transcript-time thinking-time"
        timestamp={timestamp}
      />
      <Markdown>{content}</Markdown>
    </div>
  );
}

function ThinkingBlobs({
  thinking,
  timestamp,
}: {
  thinking: readonly string[];
  timestamp?: number | string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasHiddenHistory = thinking.length > 3;
  const visibleThinking = expanded ? thinking : thinking.slice(-3);
  const occurrences = new Map<string, number>();
  const blobs = visibleThinking.map((content) => {
    const occurrence = (occurrences.get(content) ?? 0) + 1;
    occurrences.set(content, occurrence);
    return (
      <ThinkingBlob
        content={content}
        key={`${content}-${occurrence}`}
        timestamp={timestamp}
      />
    );
  });
  if (!hasHiddenHistory)
    return (
      <aside className="transcript-thinking-blobs" aria-label="Thinking">
        {blobs}
      </aside>
    );
  const earlierCount = thinking.length - 3;
  return (
    <details
      className="transcript-thinking transcript-tool-stream"
      open={expanded}
      aria-label="Thinking"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="tool-stream-meta">
        <span className="tool-stream-toggle">
          <TranscriptDisclosureIcon expanded={expanded} />
          {expanded ? 'Hide' : 'Show'} {earlierCount} earlier item
          {earlierCount === 1 ? '' : 's'}
        </span>
        <small className="tool-stream-metadata">
          <span className="tool-stream-phase tool-stream-phase-thinking">
            Thinking
          </span>
          <span className="tool-stream-metadata-separator" aria-hidden="true">
            {' · '}
          </span>
          <span className="tool-stream-metadata-thoughts">
            {thinking.length} thoughts
          </span>
        </small>
      </summary>
      <div className="transcript-thinking-blobs">{blobs}</div>
    </details>
  );
}

function ActivityStepContent({
  action,
  timestamp,
  showTimestamp = true,
  meta,
}: {
  action: ActivityStepParts;
  timestamp?: number | string;
  showTimestamp?: boolean;
  meta?: string;
}) {
  const changes = action.lineChanges;
  const hasChanges = Boolean(
    changes && (changes.added || changes.changed || changes.removed),
  );
  const changesLabel = changes
    ? [
        changes.added ? `${changes.added} lines added` : undefined,
        changes.changed ? `${changes.changed} lines changed` : undefined,
        changes.removed ? `${changes.removed} lines removed` : undefined,
      ]
        .filter(Boolean)
        .join(', ')
    : undefined;
  return (
    <>
      <span className="tool-step-dot" aria-hidden="true">
        {action.state === 'failed'
          ? '!'
          : action.state === 'pending'
            ? '…'
            : null}
      </span>
      <span
        className={`tool-name${action.described ? ' tool-name-described' : ''}`}
      >
        {action.action}
      </span>
      {(action.argument || hasChanges) && (
        <span className="tool-argument">
          {action.argument ? (
            <span className="tool-argument-text">{action.argument}</span>
          ) : null}
          {hasChanges ? (
            <span className="line-changes" title={changesLabel}>
              {changes?.added ? (
                <span className="line-change-added">+{changes.added}</span>
              ) : null}
              {changes?.changed ? (
                <span className="line-change-changed">~{changes.changed}</span>
              ) : null}
              {changes?.removed ? (
                <span className="line-change-removed">-{changes.removed}</span>
              ) : null}
            </span>
          ) : null}
        </span>
      )}
      {meta ? <span className="tool-step-meta">{meta}</span> : null}
      {showTimestamp ? (
        <DashboardTime
          className="transcript-time tool-step-time"
          timestamp={timestamp}
        />
      ) : null}
    </>
  );
}

function TranscriptEventEntry({
  event,
  timestamp,
}: {
  event: NonNullable<TranscriptModelItem['event']>;
  timestamp?: number | string;
}) {
  const [expanded, setExpanded] = useState(false);
  const failed =
    (event.kind === 'delegate-result' || event.kind === 'background-result') &&
    event.status === 'error';
  const icon =
    event.kind === 'compaction' || event.kind === 'branch-summary'
      ? '◇'
      : event.kind === 'todo'
        ? '◆'
        : event.kind === 'settings'
          ? '◈'
          : event.kind === 'delegate-feedback'
            ? '↳'
            : failed
              ? '×'
              : '✓';
  const metric =
    event.kind === 'compaction' && event.tokensBefore !== undefined
      ? `${formatCompactCount(event.tokensBefore)} tokens`
      : undefined;
  const details = expanded ? (
    event.kind === 'compaction' || event.kind === 'branch-summary' ? (
      <div className="session-event-details">
        <Markdown>{event.summary}</Markdown>
      </div>
    ) : event.kind === 'todo' ? (
      <ul className="session-event-tasks">
        {event.tasks.map((task) => (
          <li className="session-event-task" key={task.id}>
            <span>{task.id}</span>
            <strong>{task.text}</strong>
            <small>{task.status}</small>
          </li>
        ))}
      </ul>
    ) : event.kind === 'delegate-result' ||
      event.kind === 'background-result' ||
      event.kind === 'custom-message' ? (
      event.content ? (
        <div className="session-event-details">
          <Markdown>{event.content}</Markdown>
        </div>
      ) : null
    ) : null
  ) : null;
  const hasDetails =
    event.kind === 'compaction' ||
    event.kind === 'branch-summary' ||
    event.kind === 'todo' ||
    ((event.kind === 'delegate-result' ||
      event.kind === 'background-result' ||
      event.kind === 'custom-message') &&
      Boolean(event.content));
  const className = `session-event event-${event.kind}${failed ? ' event-failed' : ''}`;
  const heading = (
    <>
      <span className="session-event-icon" aria-hidden="true">
        {icon}
      </span>
      <strong>{event.label}</strong>
      {metric ? <small>{metric}</small> : null}
      <DashboardTime className="transcript-time" timestamp={timestamp} />
    </>
  );
  if (event.kind === 'delegate-feedback')
    return (
      <div className={className}>
        <div className="session-event-heading">{heading}</div>
        {event.content ? (
          <div className="session-event-details">
            <Markdown>{event.content}</Markdown>
          </div>
        ) : null}
      </div>
    );
  return hasDetails ? (
    <details
      className={className}
      onToggle={(toggleEvent) => setExpanded(toggleEvent.currentTarget.open)}
    >
      <summary>{heading}</summary>
      {details}
    </details>
  ) : (
    <div className={className}>{heading}</div>
  );
}

export interface SkillInvocation {
  name: string;
  location?: string;
  instructions: string;
  request?: string;
}

/** Recognize the model-facing skill envelope without exposing protocol noise. */
export function parseSkillInvocation(
  text: string,
): SkillInvocation | undefined {
  const match = text.match(
    /^<skill\b([^>]*)>\s*([\s\S]*?)\s*<\/skill>(?:\s*\n\n([\s\S]*))?$/u,
  );
  if (!match) return undefined;
  const name = match[1]?.match(/\bname="([^"]*)"/u)?.[1];
  if (!name) return undefined;
  const location = match[1]?.match(/\blocation="([^"]*)"/u)?.[1];
  const instructions = match[2]?.trim() ?? '';
  const request = match[3]?.trim() || undefined;
  return {
    name,
    ...(location ? { location } : {}),
    instructions,
    ...(request ? { request } : {}),
  };
}

export function SkillInvocationView({
  invocation,
}: {
  invocation: SkillInvocation;
}) {
  return (
    <div className="skill-invocation">
      <details>
        <summary>
          <span className="skill-icon" aria-hidden="true">
            ✦
          </span>
          <strong>Skill · {invocation.name}</strong>
          <small>invoked</small>
        </summary>
        <div className="skill-invocation-details">
          {invocation.location ? (
            <small>Instructions from {invocation.location}</small>
          ) : null}
          {invocation.instructions ? (
            <Markdown>{invocation.instructions}</Markdown>
          ) : null}
        </div>
      </details>
      {invocation.request ? (
        <div className="skill-invocation-request">
          <strong>Request</strong>
          <Markdown>{invocation.request}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

function TranscriptEntry({
  item,
  cwd,
  timestampOverride,
  showThinking = true,
  branchPoint,
  onOpenBranchPaths,
}: {
  item: TranscriptModelItem;
  cwd?: string;
  timestampOverride?: number | string;
  showThinking?: boolean;
  branchPoint?: SessionBranchPoint;
  onOpenBranchPaths?: (point: SessionBranchPoint) => void;
}) {
  const timestamp = transcriptItemTimestamp(item) ?? timestampOverride;
  if (item.event)
    return <TranscriptEventEntry event={item.event} timestamp={timestamp} />;
  if (item.customMessage)
    return (
      <div className="transcript-message-entry delegate-parent-request-entry">
        {item.customMessage}
      </div>
    );
  if (item.role && (item.text || item.imageCount || item.thinking?.length)) {
    const skill =
      item.role === 'user' && item.text
        ? parseSkillInvocation(item.text)
        : undefined;
    if (skill)
      return (
        <div className="transcript-message-entry">
          <SkillInvocationView invocation={skill} />
          <DashboardTime className="transcript-time" timestamp={timestamp} />
        </div>
      );
    return (
      <div className="transcript-message-entry">
        {showThinking && item.role === 'assistant' && item.thinking?.length ? (
          <ThinkingBlobs thinking={item.thinking} timestamp={timestamp} />
        ) : null}
        {item.text || item.imageCount ? (
          <article
            className={`message-bubble message-${item.role}${item.deliveryMode === 'steer' ? ' message-steering' : ''}${item.role === 'user' && branchPoint && branchPoint.paths.length > 1 ? ' message-has-branches' : ''}`}
          >
            {item.role === 'assistant' && item.text ? (
              <span className="message-bubble-accessories">
                <AssistantMessageCopyButton key={item.text} text={item.text} />
                <DashboardTime
                  className="transcript-time"
                  timestamp={timestamp}
                />
              </span>
            ) : (
              <DashboardTime
                className="transcript-time"
                timestamp={timestamp}
              />
            )}
            {item.imageCount ? (
              item.sessionId &&
              item.images?.some((image) => image.available) ? (
                <TranscriptImageGallery
                  key={`${item.sessionId}:${item.key}:${imageIndexKey(item.images)}`}
                  sessionId={item.sessionId}
                  entryId={item.key}
                  imageIndices={imageIndexKey(item.images)}
                  messageTimestamp={timestamp}
                />
              ) : (
                <span className="message-attachment">
                  {item.imageCount} image{item.imageCount === 1 ? '' : 's'}{' '}
                  attached
                </span>
              )
            ) : null}
            {item.text ? <Markdown>{item.text}</Markdown> : null}
            {item.role === 'user' &&
            branchPoint &&
            branchPoint.paths.length > 1 ? (
              <button
                type="button"
                className="transcript-branch-indicator"
                aria-label={`Show ${branchPoint.paths.length} paths from this message`}
                aria-haspopup="dialog"
                title={`Show ${branchPoint.paths.length} paths from this message`}
                data-branch-count={branchPoint.paths.length}
                onClick={() => onOpenBranchPaths?.(branchPoint)}
              >
                <span aria-hidden="true">⑂</span> {branchPoint.paths.length}{' '}
                paths
              </button>
            ) : null}
          </article>
        ) : null}
      </div>
    );
  }
  if (item.tool) {
    const tool = item.tool;
    const action = activityStepParts(
      {
        name: tool.name,
        args: tool.arguments,
        status: tool.status,
        isError: tool.isError,
      },
      cwd,
    );
    const meta = commandStepMeta({
      name: tool.name,
      args: tool.arguments,
      status: tool.status,
      isError: tool.isError,
      result: tool.result,
      data: tool.data,
    });
    return (
      <details
        className={`transcript-entry tool-detail role-${action.role} step-${action.state}`}
      >
        <summary className="tool-step">
          <ActivityStepContent
            action={action}
            meta={meta}
            timestamp={timestamp}
          />
        </summary>
        <ToolInspector tool={tool} />
      </details>
    );
  }
  const raw = item.raw;
  return (
    <details className="transcript-entry">
      <summary>
        {typeof raw === 'object' && raw && 'type' in raw
          ? String((raw as { type?: unknown }).type)
          : 'entry'}
        <DashboardTime className="transcript-time" timestamp={timestamp} />
      </summary>
      <BoundedPayloadPreview value={raw} label="raw payload" />
    </details>
  );
}

export { TranscriptEntry };
