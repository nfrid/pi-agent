import { DashboardTime } from '../../features/timestamp';
import type { TranscriptModelItem } from '../../transcript';
import {
  type ActivityStepParts,
  activityGroupMetadata,
  activityGroupMetadataModel,
  activityGroupSummary,
  type TranscriptGroup,
} from './activity';

function lineCountLabel(count: number, kind: string): string {
  return `${count} line${count === 1 ? '' : 's'} ${kind}`;
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
        changes.added ? lineCountLabel(changes.added, 'added') : undefined,
        changes.changed
          ? lineCountLabel(changes.changed, 'changed')
          : undefined,
        changes.removed
          ? lineCountLabel(changes.removed, 'removed')
          : undefined,
      ]
        .filter(Boolean)
        .join(', ')
    : undefined;
  return (
    <>
      <span className="activity-step-dot" aria-hidden="true">
        {action.state === 'failed'
          ? '!'
          : action.state === 'pending'
            ? '…'
            : null}
      </span>
      <span
        className={`activity-tool-name${action.described ? ' activity-tool-name-described' : ''}`}
      >
        {action.action}
      </span>
      {(action.argument || hasChanges) && (
        <span className="activity-tool-argument">
          {action.argument ? (
            <span className="activity-tool-argument-text">
              {action.argument}
            </span>
          ) : null}
          {hasChanges ? (
            <span className="activity-line-changes" title={changesLabel}>
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
      {meta ? <span className="activity-step-meta">{meta}</span> : null}
      {showTimestamp ? (
        <DashboardTime
          className="transcript-time activity-step-time"
          timestamp={timestamp}
        />
      ) : null}
    </>
  );
}

function activityStatusLabel(status: TranscriptGroup['status']): string {
  if (status === 'ended-error') return 'failed';
  if (status === 'live') return 'in progress';
  if (status === 'preparing') return 'preparing';
  return 'complete';
}

function ActivitySummary({
  group,
  items,
  expanded,
  compacting = false,
  detailId,
  statusId,
  onToggle,
}: {
  group: TranscriptGroup;
  items: readonly TranscriptModelItem[];
  expanded: boolean;
  compacting?: boolean;
  detailId: string;
  statusId: string;
  onToggle: (expanded: boolean) => void;
}) {
  const summary = activityGroupSummary(group);
  const metadata = activityGroupMetadataModel(group, summary);
  const compactionLabel = compacting
    ? 'Compacting'
    : items.some((item) => item.event?.kind === 'compaction')
      ? 'Compacted'
      : undefined;
  const hasLineChanges = Boolean(
    metadata.lineChanges.added ||
      metadata.lineChanges.changed ||
      metadata.lineChanges.removed,
  );
  const metadataTitle = [activityGroupMetadata(group, summary), compactionLabel]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="activity-summary">
      {summary.earlierToolCount > 0 ? (
        <button
          type="button"
          className="activity-summary-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={`${expanded ? 'Hide' : 'Show'} ${summary.earlierToolCount} earlier call${summary.earlierToolCount === 1 ? '' : 's'} · ${metadataTitle}`}
          aria-describedby={statusId}
          onClick={() => onToggle(!expanded)}
        >
          <span className="activity-summary-toggle-icon" aria-hidden="true">
            {expanded ? '⌃' : '⌄'}
          </span>
          <span>
            {expanded ? 'Hide' : 'Show'} {summary.earlierToolCount} earlier call
            {summary.earlierToolCount === 1 ? '' : 's'}
          </span>
        </button>
      ) : null}
      <small
        className={`activity-metadata activity-metadata-${group.kind}`}
        title={metadataTitle}
      >
        <span className="activity-metadata-kind">{metadata.kindLabel}</span>
        <span className="activity-metadata-separator" aria-hidden="true">
          {' · '}
        </span>
        <span className="activity-metadata-status">
          {activityStatusLabel(group.status)}
        </span>
        <span className="activity-metadata-separator" aria-hidden="true">
          {' · '}
        </span>
        <span>{metadata.toolLabel}</span>
        {hasLineChanges ? (
          <>
            <span className="activity-metadata-separator" aria-hidden="true">
              {' · '}
            </span>
            <span className="activity-metadata-changes">
              {metadata.lineChanges.added ? (
                <span className="line-change-added">
                  +{metadata.lineChanges.added}
                </span>
              ) : null}
              {metadata.lineChanges.changed ? (
                <span className="line-change-changed">
                  ~{metadata.lineChanges.changed}
                </span>
              ) : null}
              {metadata.lineChanges.removed ? (
                <span className="line-change-removed">
                  -{metadata.lineChanges.removed}
                </span>
              ) : null}
            </span>
          </>
        ) : null}
        {metadata.duration ? (
          <>
            <span className="activity-metadata-separator" aria-hidden="true">
              {' · '}
            </span>
            <span className="activity-metadata-duration">
              {metadata.duration}
            </span>
          </>
        ) : null}
        {metadata.failure ? (
          <>
            <span className="activity-metadata-separator" aria-hidden="true">
              {' · '}
            </span>
            <span className="activity-metadata-failure">
              {metadata.failure}
            </span>
          </>
        ) : null}
        {compactionLabel ? (
          <>
            <span className="activity-metadata-separator" aria-hidden="true">
              {' · '}
            </span>
            <span className="activity-metadata-compaction">
              {compactionLabel}
            </span>
          </>
        ) : null}
      </small>
    </div>
  );
}

export { ActivityStepContent, ActivitySummary };
