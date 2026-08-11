import { useState } from 'react';
import { DashboardTime } from '../../features/timestamp';
import { Markdown } from '../../Markdown';
import type { TranscriptModelItem } from '../../transcript';
import { activityStepParts } from './activity';
import { activityTitleLine } from './activity-lead';
import { ActivityStepContent } from './activity-summary';
import { ToolInspector, toolInspectorRecord } from './inspector';
import { transcriptItemTimestamp, transcriptRoleLabel } from './landmarks';

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

function compactTokenCount(tokens: number): string {
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 0,
  }).format(tokens);
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
          : failed
            ? '×'
            : '✓';
  const metric =
    event.kind === 'compaction' && event.tokensBefore !== undefined
      ? `${compactTokenCount(event.tokensBefore)} tokens`
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
  return hasDetails ? (
    <details
      className={className}
      onToggle={(toggleEvent) => setExpanded(toggleEvent.currentTarget.open)}
    >
      <summary>
        {heading}
        <span className="session-event-disclosure" aria-hidden="true">
          ›
        </span>
      </summary>
      {details}
    </details>
  ) : (
    <div className={className}>{heading}</div>
  );
}

function TranscriptEntry({
  item,
  cwd,
  timestampOverride,
}: {
  item: TranscriptModelItem;
  cwd?: string;
  timestampOverride?: number | string;
}) {
  const timestamp = transcriptItemTimestamp(item) ?? timestampOverride;
  if (item.event)
    return <TranscriptEventEntry event={item.event} timestamp={timestamp} />;
  if (item.preparing)
    return (
      <div className="transcript-entry preparing-toolcall" role="status">
        <span className="activity-icon">…</span>
        <strong>
          {item.text ? activityTitleLine(item.text) : 'Preparing tool call'}
        </strong>
        <small>preparing tool call</small>
        <DashboardTime className="transcript-time" timestamp={timestamp} />
      </div>
    );
  if (item.role && (item.text || item.imageCount || item.thinking?.length))
    return (
      <div className="transcript-message-entry">
        {item.role === 'assistant' && item.thinking?.length ? (
          <ThinkingBlobs thinking={item.thinking} timestamp={timestamp} />
        ) : null}
        {item.text || item.imageCount ? (
          <article
            className={`message-bubble message-${item.role}${item.deliveryMode === 'steer' ? ' message-steering' : ''}`}
          >
            <header className="message-meta">
              <span className="message-role">
                {transcriptRoleLabel(item.role, item.deliveryMode)}
              </span>
              <DashboardTime
                className="transcript-time"
                timestamp={timestamp}
              />
            </header>
            {item.imageCount ? (
              <span className="message-attachment">
                {item.imageCount} image{item.imageCount === 1 ? '' : 's'}{' '}
                attached
              </span>
            ) : null}
            {item.text ? <Markdown>{item.text}</Markdown> : null}
          </article>
        ) : null}
      </div>
    );
  if (item.tool) {
    const tool = item.tool;
    const record = toolInspectorRecord(tool);
    const action = activityStepParts(
      {
        name: tool.name,
        args: tool.arguments,
      },
      cwd,
    );
    return (
      <details
        className={`transcript-entry tool-detail role-${action.role} step-${action.state}`}
      >
        <summary className="activity-step">
          <ActivityStepContent action={action} timestamp={timestamp} />
        </summary>
        <ToolInspector tool={record} />
      </details>
    );
  }
  const raw = item.raw;
  const text = JSON.stringify(raw, null, 2);
  return (
    <details className="transcript-entry">
      <summary>
        {typeof raw === 'object' && raw && 'type' in raw
          ? String((raw as { type?: unknown }).type)
          : 'entry'}
        <DashboardTime className="transcript-time" timestamp={timestamp} />
      </summary>
      <pre>{text}</pre>
    </details>
  );
}

export { TranscriptEntry };
