import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { Button as AriaButton } from 'react-aria-components';
import { DashboardTime } from '../../features/timestamp';
import { Markdown } from '../../Markdown';
import type { TranscriptModelItem } from '../../transcript';
import { activityGroupPresentation, type TranscriptGroup } from './activity';
import { shouldShowActivityLead } from './activity-lead';
import { CollapsedActivitySummary } from './activity-summary';
import { TranscriptEntry } from './entries';
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
}: {
  group: TranscriptGroup;
  groupKey: string;
  items: readonly TranscriptModelItem[];
  runtime?: RuntimeSnapshot;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  captureScrollAnchor?: (key: string) => void;
}) {
  const presentation = activityGroupPresentation(group, expanded);
  const lead = items[0];
  const visibleLead =
    !lead?.preparing &&
    lead?.role === 'assistant' &&
    lead.text &&
    shouldShowActivityLead(lead.text, group.title)
      ? lead.text
      : undefined;
  const detailId = `activity-detail-${group.start}`;
  const timestamps = activityGroupItemTimestamps(items);

  return (
    <div
      className={`activity-group ${presentation.className}`}
      data-transcript-key={`group-${groupKey}`}
    >
      <AriaButton
        className="activity-group-header"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        onPress={() => {
          captureScrollAnchor?.(`group-${groupKey}`);
          onToggle(!expanded);
        }}
      >
        <span className="activity-icon">{presentation.icon}</span>
        <strong>{group.title}</strong>
        <span className="sr-only">
          {group.toolCount} tool{group.toolCount === 1 ? '' : 's'} ·{' '}
          {presentation.label}
        </span>
        <small aria-hidden="true">{presentation.label}</small>
        <DashboardTime
          className="transcript-time activity-time"
          timestamp={transcriptItemTimestamp(lead)}
        />
      </AriaButton>
      {!expanded && (
        <CollapsedActivitySummary
          group={group}
          items={items}
          cwd={runtime?.cwd}
        />
      )}
      {visibleLead && (
        <div className="activity-lead">
          <span className="message-role">agent</span>
          <Markdown>{visibleLead}</Markdown>
        </div>
      )}
      {expanded && (
        <div className="activity-detail" id={detailId}>
          {items.map((child, childIndex) => (
            <TranscriptEntry
              key={child.key}
              item={child}
              cwd={runtime?.cwd}
              timestampOverride={timestamps[childIndex]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
