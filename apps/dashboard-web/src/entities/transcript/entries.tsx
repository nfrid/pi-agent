import { useState } from 'react';
import { DashboardTime } from '../../features/timestamp';
import { Markdown } from '../../Markdown';
import { formatCompactCount } from '../../shared/lib/format';
import type { TranscriptModelItem } from '../../transcript';
import { activityStepParts, commandStepMeta } from './activity';
import { ActivityStepContent } from './activity-summary';
import { BoundedPayloadPreview, ToolInspector } from './inspector';
import { transcriptItemTimestamp } from './landmarks';

async function copyText(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
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

function ThinkingBlobs({
  thinking,
  timestamp,
}: {
  thinking: readonly string[];
  timestamp?: number | string;
}) {
  const occurrences = new Map<string, number>();
  return (
    <aside className="transcript-thinking-blobs" aria-label="Thinking">
      {thinking.map((content) => {
        const occurrence = (occurrences.get(content) ?? 0) + 1;
        occurrences.set(content, occurrence);
        return (
          <div
            className="transcript-thinking-blob"
            key={`${content}-${occurrence}`}
          >
            <DashboardTime
              className="transcript-time thinking-time"
              timestamp={timestamp}
            />
            <Markdown>{content}</Markdown>
          </div>
        );
      })}
    </aside>
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
          <span className="activity-icon" aria-hidden="true">
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
  suppressAssistantText = false,
}: {
  item: TranscriptModelItem;
  cwd?: string;
  timestampOverride?: number | string;
  /** The activity header owns the preamble; retain all supplemental content. */
  suppressAssistantText?: boolean;
}) {
  const timestamp = transcriptItemTimestamp(item) ?? timestampOverride;
  if (item.event)
    return <TranscriptEventEntry event={item.event} timestamp={timestamp} />;
  if (
    item.role &&
    suppressAssistantText &&
    !item.imageCount &&
    !item.thinking?.length
  )
    return null;
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
        {item.role === 'assistant' && item.thinking?.length ? (
          <ThinkingBlobs thinking={item.thinking} timestamp={timestamp} />
        ) : null}
        {(item.text && !suppressAssistantText) || item.imageCount ? (
          <article
            className={`message-bubble message-${item.role}${item.deliveryMode === 'steer' ? ' message-steering' : ''}`}
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
              <span className="message-attachment">
                {item.imageCount} image{item.imageCount === 1 ? '' : 's'}{' '}
                attached
              </span>
            ) : null}
            {item.text && !suppressAssistantText ? (
              <Markdown>{item.text}</Markdown>
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
        <summary className="activity-step">
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
