import { DashboardTime } from '../../features/timestamp';
import type { TranscriptModelItem } from '../../transcript';
import {
  type ActivityStepParts,
  activityGroupMetadata,
  activityGroupSummary,
  activityStepParts,
  commandStepMeta,
  type TranscriptGroup,
} from './activity';
import { activityStepTimestamps } from './landmarks';

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
      <span className="activity-tool-name">{action.action}</span>
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

function CollapsedActivitySummary({
  group,
  items,
  cwd,
}: {
  group: TranscriptGroup;
  items: readonly TranscriptModelItem[];
  cwd?: string;
}) {
  const summary = activityGroupSummary(group);
  const allTimestamps = activityStepTimestamps(items);
  const recentActions = group.tools
    .slice(-summary.recentTools.length)
    .map((tool, index) => ({
      action: activityStepParts(tool, cwd),
      meta: commandStepMeta(tool),
      timestamp:
        allTimestamps[
          allTimestamps.length - summary.recentTools.length + index
        ],
    }));
  const stepKeyCounts = new Map<string, number>();
  return (
    <div className="activity-summary">
      {summary.earlierToolCount > 0 && (
        <span className="activity-earlier">
          ⋮ {summary.earlierToolCount} earlier step
          {summary.earlierToolCount === 1 ? '' : 's'}
        </span>
      )}
      {recentActions.length > 0 && (
        <ol className="activity-steps">
          {recentActions.map(({ action, meta, timestamp }) => {
            const occurrence = (stepKeyCounts.get(action.label) ?? 0) + 1;
            stepKeyCounts.set(action.label, occurrence);
            return (
              <li
                className={`activity-step role-${action.role} step-${action.state}`}
                key={`${action.label}-${occurrence}`}
              >
                <ActivityStepContent
                  action={action}
                  meta={meta}
                  showTimestamp={false}
                  timestamp={timestamp}
                />
              </li>
            );
          })}
        </ol>
      )}
      <small className="activity-metadata">
        {activityGroupMetadata(summary)}
      </small>
    </div>
  );
}

export { ActivityStepContent, CollapsedActivitySummary };
