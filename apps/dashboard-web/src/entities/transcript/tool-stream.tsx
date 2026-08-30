import { activityKind } from '@pi-dashboard/activity-model';
import { useId } from 'react';
import type { TranscriptModelItem } from '../../transcript';
import {
  toolStreamDurationLabel,
  toolStreamKindLabel,
  toolStreamMetadata,
  toolStreamStatus,
} from './activity';
import { ThinkingBlob, TranscriptEntry } from './entries';
import { transcriptItemTimestamp } from './landmarks';

function toolDescriptor(item: TranscriptModelItem) {
  const tool = item.tool;
  if (!tool) return undefined;
  return {
    name: tool.name,
    args: tool.arguments,
    status: tool.status,
    isError: tool.isError,
    result: tool.result,
    data: tool.data,
  };
}

type ToolStreamHistoryEntry =
  | {
      kind: 'thought';
      key: string;
      content: string;
      timestamp?: number | string;
    }
  | {
      kind: 'call' | 'event';
      key: string;
      item: TranscriptModelItem;
      timestampOverride?: number | string;
    };

function metadataStatusLabel(status: ReturnType<typeof toolStreamStatus>) {
  return status === 'failed'
    ? 'failed'
    : status === 'in-progress'
      ? 'in progress'
      : 'complete';
}

function MetadataSeparator() {
  return (
    <span className="tool-stream-metadata-separator" aria-hidden="true">
      {' · '}
    </span>
  );
}

export function TranscriptToolStream({
  items,
  cwd,
  expanded,
  onToggle,
  captureScrollAnchor,
  timestampOverride,
}: {
  items: readonly TranscriptModelItem[];
  cwd?: string;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  captureScrollAnchor?: (key: string) => void;
  timestampOverride?: number | string;
}) {
  const first = items[0];
  const streamKey = first?.key ?? 'tool-stream';
  const tools = items.flatMap((item) => {
    const tool = toolDescriptor(item);
    return tool ? [tool] : [];
  });
  let latestAssistantTimestamp = timestampOverride;
  const history: ToolStreamHistoryEntry[] = [];
  for (const item of items) {
    if (item.role === 'assistant') {
      latestAssistantTimestamp =
        transcriptItemTimestamp(item) ?? latestAssistantTimestamp;
      for (const [index, content] of (item.thinking ?? []).entries())
        history.push({
          kind: 'thought',
          key: `${item.key}:thought:${index}`,
          content,
          timestamp: latestAssistantTimestamp,
        });
    } else if (item.tool) {
      history.push({
        kind: 'call',
        key: item.key,
        item,
        timestampOverride: latestAssistantTimestamp,
      });
    } else if (
      item.event &&
      item.entry.kind === 'other' &&
      item.entry.continuesGroup
    ) {
      history.push({
        kind: 'event',
        key: item.key,
        item,
        timestampOverride:
          transcriptItemTimestamp(item) ?? latestAssistantTimestamp,
      });
    }
  }
  const thinkingCount = history.filter(
    (entry) => entry.kind === 'thought',
  ).length;
  const collapsedHistory = history
    .filter(
      (entry) =>
        entry.kind !== 'event' ||
        (entry.item.event?.kind !== 'todo' &&
          entry.item.event?.kind !== 'settings' &&
          entry.item.event?.kind !== 'custom-message'),
    )
    .slice(-3);
  const hiddenHistoryCount = history.length - collapsedHistory.length;
  const summary = toolStreamMetadata(tools);
  const kind = activityKind(tools);
  const status = toolStreamStatus(tools);
  const metadataTitle = [
    toolStreamKindLabel(kind),
    metadataStatusLabel(status),
    thinkingCount > 0
      ? `${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}`
      : undefined,
    `${tools.length} call${tools.length === 1 ? '' : 's'}`,
    summary.lineChanges.added ? `+${summary.lineChanges.added}` : undefined,
    summary.lineChanges.changed ? `~${summary.lineChanges.changed}` : undefined,
    summary.lineChanges.removed ? `-${summary.lineChanges.removed}` : undefined,
    summary.durationMs > 0
      ? toolStreamDurationLabel(summary.durationMs)
      : undefined,
    summary.failureCount > 0 ? `${summary.failureCount} failed` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const detailId = useId();
  const visibleHistory = expanded ? history : collapsedHistory;
  const earlierLabel = `${hiddenHistoryCount} earlier item${hiddenHistoryCount === 1 ? '' : 's'}`;
  const toggle = () => {
    captureScrollAnchor?.(streamKey);
    onToggle(!expanded);
  };
  const renderPreamble = () =>
    first && (first.text || first.imageCount) ? (
      <div key={first.key}>
        <TranscriptEntry
          item={first}
          cwd={cwd}
          showThinking={false}
          timestampOverride={timestampOverride}
        />
      </div>
    ) : null;
  const renderHistory = (visible: typeof history, includeItemKeys: boolean) =>
    visible.map((entry) => {
      if (entry.kind === 'thought')
        return (
          <ThinkingBlob
            content={entry.content}
            key={entry.key}
            timestamp={entry.timestamp}
          />
        );
      return (
        <div
          className={includeItemKeys ? 'tool-stream-direct-item' : undefined}
          {...(includeItemKeys
            ? { 'data-transcript-key': entry.item.key }
            : {})}
          key={entry.key}
        >
          <TranscriptEntry
            item={entry.item}
            cwd={cwd}
            timestampOverride={entry.timestampOverride}
          />
        </div>
      );
    });

  if (hiddenHistoryCount === 0)
    return (
      <div data-transcript-key={streamKey}>
        {renderPreamble()}
        <div className="tool-stream-items">{renderHistory(history, true)}</div>
      </div>
    );

  return (
    <section
      className={`transcript-tool-stream${expanded ? ' transcript-tool-stream-expanded' : ''}`}
      data-transcript-key={streamKey}
      aria-label="Tool calls, thinking, and events"
    >
      {renderPreamble()}
      <div className="tool-stream-meta" id={`${detailId}-meta`}>
        <button
          type="button"
          className="tool-stream-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={`${expanded ? 'Hide' : 'Show'} ${earlierLabel} · ${metadataTitle}`}
          onClick={toggle}
        >
          <span className="transcript-disclosure-icon" aria-hidden="true">
            {expanded ? '⌃' : '⌄'}
          </span>
          {expanded ? 'Hide' : 'Show'} {earlierLabel}
        </button>
        <small
          className={`tool-stream-metadata tool-stream-metadata-${kind}`}
          title={metadataTitle}
        >
          <span className="tool-stream-metadata-kind">
            {toolStreamKindLabel(kind)}
          </span>
          <MetadataSeparator />
          <span
            className={`tool-stream-metadata-status tool-stream-status-${status}`}
          >
            {metadataStatusLabel(status)}
          </span>
          {thinkingCount > 0 ? (
            <>
              <MetadataSeparator />
              <span className="tool-stream-metadata-thoughts">
                {thinkingCount} thought{thinkingCount === 1 ? '' : 's'}
              </span>
            </>
          ) : null}
          <MetadataSeparator />
          <span className="tool-stream-metadata-calls">
            {tools.length} call{tools.length === 1 ? '' : 's'}
          </span>
          {summary.lineChanges.added ||
          summary.lineChanges.changed ||
          summary.lineChanges.removed ? (
            <>
              <MetadataSeparator />
              <span className="tool-stream-metadata-changes">
                {summary.lineChanges.added ? (
                  <span className="line-change-added">
                    +{summary.lineChanges.added}
                  </span>
                ) : null}
                {summary.lineChanges.changed ? (
                  <span className="line-change-changed">
                    ~{summary.lineChanges.changed}
                  </span>
                ) : null}
                {summary.lineChanges.removed ? (
                  <span className="line-change-removed">
                    -{summary.lineChanges.removed}
                  </span>
                ) : null}
              </span>
            </>
          ) : null}
          {summary.durationMs > 0 ? (
            <>
              <MetadataSeparator />
              <span className="tool-stream-metadata-duration">
                {toolStreamDurationLabel(summary.durationMs)}
              </span>
            </>
          ) : null}
          {summary.failureCount > 0 ? (
            <>
              <MetadataSeparator />
              <span className="tool-stream-metadata-failure">
                {summary.failureCount} failed
              </span>
            </>
          ) : null}
        </small>
      </div>
      <div
        className="tool-stream-items"
        id={detailId}
        aria-describedby={`${detailId}-meta`}
      >
        {renderHistory(visibleHistory, false)}
      </div>
    </section>
  );
}
