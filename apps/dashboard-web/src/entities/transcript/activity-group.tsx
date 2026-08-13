import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { type MouseEvent, useEffect, useRef } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { DashboardTime } from '../../features/timestamp';
import { Markdown } from '../../Markdown';
import type { TranscriptModelItem } from '../../transcript';
import { activityGroupPresentation, type TranscriptGroup } from './activity';
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
  const preamble =
    !lead?.preparing && lead?.role === 'assistant' && lead.text
      ? lead.text
      : undefined;
  const detailId = `activity-detail-${group.start}`;
  const labelId = `activity-label-${group.start}`;
  const statusId = `activity-status-${group.start}`;
  const timestamps = activityGroupItemTimestamps(items);
  const groupRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const groupElement = groupRef.current;
    const headerElement = headerRef.current;
    if (
      !groupElement ||
      !headerElement ||
      typeof ResizeObserver === 'undefined'
    )
      return;

    const updateHeaderHeight = () => {
      groupElement.style.setProperty(
        '--activity-header-height',
        `${headerElement.getBoundingClientRect().height}px`,
      );
    };
    updateHeaderHeight();
    const observer = new ResizeObserver(updateHeaderHeight);
    observer.observe(headerElement);
    return () => observer.disconnect();
  }, []);

  const toggle = () => {
    captureScrollAnchor?.(`group-${groupKey}`);
    onToggle(!expanded);
  };
  const handleHeaderClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        'a, button, input, select, textarea, summary, [contenteditable="true"], [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])',
      )
    )
      return;
    toggle();
  };
  return (
    <div
      ref={groupRef}
      className={`activity-group ${presentation.className}`}
      data-transcript-key={`group-${groupKey}`}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the nested button remains the keyboard control while the header surface delegates pointer clicks. */}
      <header
        ref={headerRef}
        className="activity-group-header"
        onClick={handleHeaderClick}
      >
        <span className="activity-group-accessories">
          <DashboardTime
            className="transcript-time activity-time"
            timestamp={transcriptItemTimestamp(lead)}
          />
        </span>
        <AriaButton
          className="activity-group-toggle"
          type="button"
          aria-labelledby={labelId}
          aria-describedby={statusId}
          aria-expanded={expanded}
          aria-controls={detailId}
          onPress={toggle}
        >
          <span className="activity-icon" aria-hidden="true">
            {presentation.icon}
          </span>
        </AriaButton>
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
      {!expanded && (
        <CollapsedActivitySummary
          group={group}
          items={items}
          cwd={runtime?.cwd}
        />
      )}
      {expanded && (
        <div className="activity-detail" id={detailId}>
          {items.map((child, childIndex) => (
            <TranscriptEntry
              key={child.key}
              item={child}
              cwd={runtime?.cwd}
              timestampOverride={timestamps[childIndex]}
              suppressAssistantText={child === lead && Boolean(preamble)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
