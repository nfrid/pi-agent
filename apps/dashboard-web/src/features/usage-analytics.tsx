import {
  dashboardHttpClient,
  usageHistoryQueryOptions,
} from '@pi-dashboard/client';
import {
  isUsageResetBoundary,
  type UsageBurnRate,
  type UsageHistoryPoint,
  type UsageHistoryRange,
  type UsageHistorySeries,
} from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import {
  type KeyboardEvent,
  type PointerEvent,
  useMemo,
  useState,
} from 'react';
import styles from './usage-analytics.module.css';

const RANGE_LABELS: ReadonlyArray<{
  range: UsageHistoryRange;
  label: string;
}> = [
  { range: '24h', label: '24h' },
  { range: '7d', label: '7d' },
  { range: '30d', label: '30d' },
  { range: 'all', label: 'All' },
];

function chartPoints(points: readonly UsageHistoryPoint[]) {
  const first = points[0]?.capturedAt ?? 0;
  const last = points.at(-1)?.capturedAt ?? first + 1;
  const span = Math.max(1, last - first);
  return points.map((point) => ({
    ...point,
    x: ((point.capturedAt - first) / span) * 100,
    y: 2 + ((100 - point.usedPercent) / 100) * 26,
  }));
}

export function UsageSparkline({
  points,
  label,
}: {
  points: readonly UsageHistoryPoint[];
  label: string;
}) {
  const plotted = chartPoints(points);
  if (plotted.length < 2)
    return <span className={styles.collecting}>Collecting history</span>;
  const path = plotted
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ');
  return (
    <svg
      className={styles.sparkline}
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label} usage history`}
    >
      <path d={path} />
    </svg>
  );
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours < 24) return `${hours}h${remaining ? ` ${remaining}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

function resetIndexes(points: readonly UsageHistoryPoint[]): Set<number> {
  const resets = new Set<number>();
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    if (current && previous && isUsageResetBoundary(previous, current))
      resets.add(index);
  }
  return resets;
}

export function clampUsagePointIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function UsageChart({ series }: { series: UsageHistorySeries }) {
  const plotted = useMemo(() => chartPoints(series.points), [series.points]);
  const resets = useMemo(() => resetIndexes(series.points), [series.points]);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, series.points.length - 1),
  );
  const selectedIndex = clampUsagePointIndex(activeIndex, series.points.length);
  const active = series.points[selectedIndex];
  const path = plotted
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ');
  const selectFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (plotted.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 100;
    let nearest = 0;
    for (let index = 1; index < plotted.length; index += 1)
      if (
        Math.abs((plotted[index]?.x ?? 0) - x) <
        Math.abs((plotted[nearest]?.x ?? 0) - x)
      )
        nearest = index;
    setActiveIndex(nearest);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setActiveIndex(
      clampUsagePointIndex(
        selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1),
        series.points.length,
      ),
    );
  };
  if (series.points.length < 2)
    return <div className={styles.emptyChart}>Collecting history</div>;
  const activePlot = plotted[selectedIndex];
  return (
    <div
      className={styles.chart}
      tabIndex={0}
      role="slider"
      aria-label={`${series.windowLabel} usage history sample`}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, series.points.length - 1)}
      aria-valuenow={selectedIndex}
      aria-valuetext={
        active
          ? `${formatTimestamp(active.capturedAt)}, ${Math.round(active.usedPercent)}% used`
          : undefined
      }
      onPointerMove={selectFromPointer}
      onKeyDown={onKeyDown}
    >
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
        <path className={styles.gridLine} d="M0,2 L100,2" />
        <path className={styles.gridLine} d="M0,15 L100,15" />
        <path className={styles.gridLine} d="M0,28 L100,28" />
        {plotted.map((point, index) =>
          resets.has(index) ? (
            <path
              className={styles.resetLine}
              d={`M${point.x},2 L${point.x},28`}
              key={`${point.capturedAt}-reset`}
            />
          ) : null,
        )}
        <path className={styles.historyLine} d={path} />
        {activePlot && (
          <circle
            className={styles.activePoint}
            cx={activePlot.x}
            cy={activePlot.y}
            r="1.6"
          />
        )}
      </svg>
      {active && (
        <div className={styles.tooltip} role="status">
          <time dateTime={new Date(active.capturedAt).toISOString()}>
            {formatTimestamp(active.capturedAt)}
          </time>
          <strong>{Math.round(active.usedPercent)}%</strong>
          {resets.has(selectedIndex) && <span>reset</span>}
        </div>
      )}
    </div>
  );
}

export function usageProjection(rate: UsageBurnRate, now: number): string {
  if (rate.projectedExhaustionAt === undefined)
    return 'No exhaustion estimate yet.';
  if (rate.projectedExhaustionAt <= now) return 'Limit exhausted.';
  if (rate.exhaustsBeforeReset === false)
    return 'Reset should arrive before the limit.';
  const until = formatDuration(rate.projectedExhaustionAt - now);
  return rate.exhaustsBeforeReset === true
    ? `Projected limit in ${until}.`
    : `Projected limit in ${until}. Reset timing unknown.`;
}

function BurnRate({
  series,
  now,
}: {
  series: UsageHistorySeries;
  now: number;
}) {
  const rate = series.burnRate;
  if (!rate)
    return (
      <p className={styles.projection}>Not enough movement to estimate burn.</p>
    );
  const rateLabel =
    rate.percentPerHour < 1
      ? rate.percentPerHour.toFixed(2)
      : rate.percentPerHour.toFixed(1);
  const projection = usageProjection(rate, now);
  return (
    <p className={styles.projection}>
      <strong>{rateLabel}%/h</strong> over{' '}
      {formatDuration(rate.observedHours * 3_600_000)}. {projection}
    </p>
  );
}

export function UsageAnalyticsPanel() {
  const [range, setRange] = useState<UsageHistoryRange>('24h');
  const history = useQuery(
    usageHistoryQueryOptions(dashboardHttpClient, range),
  );
  const series = history.data?.series ?? [];
  return (
    <div className={styles.analytics}>
      <fieldset className={styles.rangeSelector}>
        <legend className="sr-only">Usage history range</legend>
        {RANGE_LABELS.map((item) => (
          <button
            type="button"
            aria-pressed={range === item.range}
            onClick={() => setRange(item.range)}
            key={item.range}
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      {history.isPending && <p className={styles.status}>Loading history…</p>}
      {history.isError && (
        <p className={styles.status} role="alert">
          Usage history is unavailable.
        </p>
      )}
      {!history.isPending && !history.isError && series.length === 0 && (
        <p className={styles.status}>Collecting usage history.</p>
      )}
      <div className={styles.seriesList}>
        {series.map((item) => {
          const current = item.points.at(-1);
          return (
            <section
              className={styles.seriesCard}
              key={`${item.limitId}-${item.windowKind}`}
            >
              <header>
                <div>
                  <p className={styles.limitName}>{item.limitName}</p>
                  <h3>{item.windowLabel} window</h3>
                </div>
                {current && (
                  <strong className={styles.currentUsage}>
                    {Math.round(current.usedPercent)}%
                  </strong>
                )}
              </header>
              <UsageChart key={range} series={item} />
              <BurnRate
                series={item}
                now={history.data?.generatedAt ?? Date.now()}
              />
              {current?.resetsAt !== undefined && (
                <p className={styles.resetAt}>
                  Resets {formatTimestamp(current.resetsAt)}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
