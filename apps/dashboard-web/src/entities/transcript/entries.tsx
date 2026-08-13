import { useState } from 'react';
import { DashboardTime } from '../../features/timestamp';
import { Markdown } from '../../Markdown';
import type {
  TranscriptModelItem,
  TranscriptStructuredResult,
} from '../../transcript';
import { activityStepParts } from './activity';
import { activityTitleLine } from './activity-lead';
import { ActivityStepContent } from './activity-summary';
import {
  BoundedPayloadPreview,
  StructuredResultSection,
  ToolInspector,
} from './inspector';
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

export function StructuredDelegateResults({
  results,
}: {
  results: readonly TranscriptStructuredResult[];
}) {
  const occurrences = new Map<string, number>();
  return (
    <section
      className="session-event-structured-results"
      aria-label="Structured delegate results"
    >
      {results.map((result) => {
        const occurrence = (occurrences.get(result.label) ?? 0) + 1;
        occurrences.set(result.label, occurrence);
        return (
          <StructuredResultSection
            ariaLabel={result.label}
            key={`${result.label}-${occurrence}`}
            rawJsonLabel={`${result.label} structured result JSON`}
            result={result}
            title={result.label}
          />
        );
      })}
    </section>
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
      <>
        {event.content ? (
          <div className="session-event-details">
            <Markdown>{event.content}</Markdown>
          </div>
        ) : null}
        {event.kind === 'delegate-result' && event.structuredResults ? (
          <StructuredDelegateResults results={event.structuredResults} />
        ) : null}
      </>
    ) : null
  ) : null;
  const hasDetails =
    event.kind === 'compaction' ||
    event.kind === 'branch-summary' ||
    event.kind === 'todo' ||
    ((event.kind === 'delegate-result' ||
      event.kind === 'background-result' ||
      event.kind === 'custom-message') &&
      (Boolean(event.content) ||
        (event.kind === 'delegate-result' &&
          Boolean(event.structuredResults?.length))));
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
          <span className="session-event-disclosure" aria-hidden="true">
            ›
          </span>
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
      <output className="transcript-entry preparing-toolcall">
        <span className="activity-icon">…</span>
        <strong>
          {item.text ? activityTitleLine(item.text) : 'Preparing tool call'}
        </strong>
        <small>preparing tool call</small>
        <DashboardTime className="transcript-time" timestamp={timestamp} />
      </output>
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
    return (
      <details
        className={`transcript-entry tool-detail role-${action.role} step-${action.state}`}
      >
        <summary className="activity-step">
          <ActivityStepContent action={action} timestamp={timestamp} />
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
