import { activityPhases } from '@pi-dashboard/activity-model';
import { useId } from 'react';
import type { TranscriptModelItem } from '../../transcript';
import {
  toolStreamDurationLabel,
  toolStreamMetadata,
  toolStreamPhaseLabel,
} from './activity';
import { TranscriptDisclosureIcon } from './disclosure-icon';
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
  previewStartCount = 1,
  previewEndCount = 3,
}: {
  items: readonly TranscriptModelItem[];
  cwd?: string;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  captureScrollAnchor?: (key: string) => void;
  timestampOverride?: number | string;
  previewStartCount?: number;
  previewEndCount?: number;
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
  const previewableHistory = history.filter(
    (entry) =>
      entry.kind !== 'event' ||
      (entry.item.event?.kind !== 'todo' &&
        entry.item.event?.kind !== 'settings' &&
        entry.item.event?.kind !== 'custom-message'),
  );
  const leadingHistory = previewableHistory.slice(0, previewStartCount);
  const leadingKeys = new Set(leadingHistory.map((entry) => entry.key));
  const trailingHistory = (
    previewEndCount > 0 ? previewableHistory.slice(-previewEndCount) : []
  ).filter((entry) => !leadingKeys.has(entry.key));
  const collapsedHistory = [...leadingHistory, ...trailingHistory];
  const hiddenHistoryCount = history.length - collapsedHistory.length;
  const summary = toolStreamMetadata(tools);
  const phases = activityPhases(tools);
  const phaseOccurrences = new Map<string, number>();
  const renderedPhases = phases.map((phase) => {
    const occurrence = (phaseOccurrences.get(phase) ?? 0) + 1;
    phaseOccurrences.set(phase, occurrence);
    return { phase, key: `${phase}:${occurrence}` };
  });
  const phaseLabel =
    tools.length > 0
      ? phases.map(toolStreamPhaseLabel).join(' → ')
      : 'Thinking';
  const metadataTitle = [
    phaseLabel,
    thinkingCount > 0
      ? `${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}`
      : undefined,
    tools.length > 0
      ? `${tools.length} call${tools.length === 1 ? '' : 's'}`
      : undefined,
    summary.failureCount > 0 ? `${summary.failureCount} failed` : undefined,
    summary.lineChanges.added ? `+${summary.lineChanges.added}` : undefined,
    summary.lineChanges.changed ? `~${summary.lineChanges.changed}` : undefined,
    summary.lineChanges.removed ? `-${summary.lineChanges.removed}` : undefined,
    summary.durationMs > 0
      ? toolStreamDurationLabel(summary.durationMs)
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const detailId = useId();
  const hiddenLabel = `${hiddenHistoryCount} hidden step${hiddenHistoryCount === 1 ? '' : 's'}`;
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
      aria-label={
        tools.length > 0 ? 'Tool calls, thinking, and events' : 'Thinking'
      }
    >
      {renderPreamble()}
      <div className="tool-stream-meta" id={`${detailId}-meta`}>
        <button
          type="button"
          className="tool-stream-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={`${expanded ? 'Collapse' : 'Show all'} activity · ${hiddenLabel} · ${metadataTitle}`}
          onClick={toggle}
        >
          <TranscriptDisclosureIcon expanded={expanded} />
          {expanded ? 'Collapse activity' : 'Show all activity'}
        </button>
        <small className="tool-stream-metadata" title={metadataTitle}>
          {tools.length > 0 ? (
            <span className="tool-stream-metadata-phases">
              {renderedPhases.map(({ phase, key }, index) => (
                <span key={key}>
                  {index > 0 ? (
                    <span
                      className="tool-stream-phase-separator"
                      aria-hidden="true"
                    >
                      {' → '}
                    </span>
                  ) : null}
                  <span
                    className={`tool-stream-phase tool-stream-phase-${phase}`}
                  >
                    {toolStreamPhaseLabel(phase)}
                  </span>
                </span>
              ))}
            </span>
          ) : (
            <span className="tool-stream-phase tool-stream-phase-thinking">
              Thinking
            </span>
          )}
          {thinkingCount > 0 ? (
            <>
              <MetadataSeparator />
              <span className="tool-stream-metadata-thoughts">
                {thinkingCount} thought{thinkingCount === 1 ? '' : 's'}
              </span>
            </>
          ) : null}
          {tools.length > 0 ? (
            <>
              <MetadataSeparator />
              <span className="tool-stream-metadata-calls">
                {tools.length} call{tools.length === 1 ? '' : 's'}
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
        </small>
      </div>
      <div
        className="tool-stream-items"
        id={detailId}
        aria-describedby={`${detailId}-meta`}
      >
        {expanded ? (
          renderHistory(history, false)
        ) : (
          <>
            {renderHistory(leadingHistory, false)}
            <button
              type="button"
              className="tool-stream-omission"
              aria-label={`Show ${hiddenLabel}`}
              onClick={toggle}
            >
              <span aria-hidden="true">···</span>
              Show {hiddenLabel}
              <span aria-hidden="true">···</span>
            </button>
            {renderHistory(trailingHistory, false)}
          </>
        )}
      </div>
    </section>
  );
}
