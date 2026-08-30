import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMemo } from 'react';
import { DashboardTime } from '../../features/timestamp';
import { Markdown } from '../../Markdown';
import type { TranscriptModelItem } from '../../transcript';
import {
  activityGroupPresentation,
  activityGroupSummary,
  type TranscriptGroup,
} from './activity';
import { ActivitySummary } from './activity-summary';
import { AssistantMessageCopyButton, TranscriptEntry } from './entries';
import {
  activityGroupItemTimestamps,
  transcriptItemTimestamp,
} from './landmarks';

export function TranscriptActivityGroup({
  group,
  groupKey,
  items,
  runtime,
  expanded,
  onToggle,
  captureScrollAnchor,
  compacting = false,
}: {
  group: TranscriptGroup;
  groupKey: string;
  items: readonly TranscriptModelItem[];
  runtime?: RuntimeSnapshot;
  expanded: boolean;
  compacting?: boolean;
  onToggle: (expanded: boolean) => void;
  captureScrollAnchor?: (key: string) => void;
}) {
  const presentation = activityGroupPresentation(group, expanded);
  const lead = items[0];
  const preamble =
    lead?.entry.kind === 'assistant' &&
    lead.entry.titleKind === 'preamble' &&
    lead.text
      ? lead.text
      : undefined;
  const detailId = `activity-detail-${group.start}`;
  const labelId = `activity-label-${group.start}`;
  const statusId = `activity-status-${group.start}`;
  const timestamps = activityGroupItemTimestamps(items);
  const summary = activityGroupSummary(group);
  const toolIndexes = useMemo(
    () =>
      items.flatMap((item, index) =>
        item.entry.kind === 'tool' ? [index] : [],
      ),
    [items],
  );
  const visibleIndexes = expanded
    ? items.map((_, index) => index)
    : summary.recentTools.length > 0
      ? toolIndexes.slice(-summary.recentTools.length)
      : [];

  const toggle = (nextExpanded: boolean) => {
    captureScrollAnchor?.(`group-${groupKey}`);
    onToggle(nextExpanded);
  };

  return (
    <div
      className={`activity-group ${presentation.className}`}
      data-transcript-key={`group-${groupKey}`}
    >
      <header className="activity-group-header">
        <span className="activity-group-accessories">
          {preamble ? (
            <AssistantMessageCopyButton key={preamble} text={preamble} />
          ) : null}
          <DashboardTime
            className="transcript-time activity-time"
            timestamp={transcriptItemTimestamp(lead)}
          />
        </span>
        <span className="activity-icon" aria-hidden="true">
          {presentation.icon}
        </span>
        <span id={statusId} className="sr-only activity-group-status">
          {group.toolCount} tool{group.toolCount === 1 ? '' : 's'} ·{' '}
          {presentation.label}
        </span>
        {preamble ? (
          <div id={labelId} className="activity-group-preamble">
            <Markdown>{preamble}</Markdown>
          </div>
        ) : (
          <strong id={labelId} className="activity-group-fallback">
            {group.title}
          </strong>
        )}
      </header>
      <ActivitySummary
        group={group}
        items={items}
        expanded={expanded}
        compacting={compacting}
        detailId={detailId}
        labelId={labelId}
        statusId={statusId}
        onToggle={toggle}
      />
      <section
        className={`activity-detail${expanded ? ' activity-detail-expanded' : ''}`}
        id={detailId}
        aria-labelledby={labelId}
        tabIndex={expanded ? 0 : undefined}
      >
        {visibleIndexes.map((itemIndex) => {
          const child = items[itemIndex];
          if (!child) return null;
          return (
            <TranscriptEntry
              key={child.key}
              item={child}
              cwd={runtime?.cwd}
              timestampOverride={timestamps[itemIndex]}
              suppressAssistantText={child === lead && Boolean(preamble)}
            />
          );
        })}
      </section>
    </div>
  );
}
