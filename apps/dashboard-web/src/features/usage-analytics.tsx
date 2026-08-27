import {
  dashboardHttpClient,
  usageHistoryQueryOptions,
} from '@pi-dashboard/client';
import type {
  UsageBurnRate,
  UsageHistoryPoint,
  UsageHistoryRange,
  UsageHistoryResponse,
  UsageSpendPoint,
} from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  modelDisplayPreference,
  useModelDisplayPreferences,
} from './model-display-preferences';
import styles from './usage-analytics.module.css';

const RANGES: ReadonlyArray<{ range: UsageHistoryRange; label: string }> = [
  { range: '24h', label: '24h' },
  { range: '7d', label: '7d' },
  { range: '30d', label: '30d' },
];

const RANGE_MS: Record<UsageHistoryRange, number> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

const DRACULA_BASE_COLORS = [
  'var(--purple)',
  'var(--pink)',
  'var(--cyan)',
  'var(--orange)',
  'var(--green)',
  'var(--yellow)',
  'var(--red)',
] as const;

const PRIMARY_SERIES_COLORS = [
  'var(--purple)',
  'var(--pink)',
  'var(--cyan)',
  'color-mix(in srgb, var(--cyan) 55%, var(--line))',
  'color-mix(in srgb, var(--purple) 70%, var(--fg))',
  'color-mix(in srgb, var(--pink) 62%, var(--purple))',
] as const;

const SERIES_COLORS = [
  ...PRIMARY_SERIES_COLORS,
  'var(--orange)',
  'var(--green)',
  'var(--yellow)',
  'var(--red)',
  'color-mix(in srgb, var(--orange) 65%, var(--pink))',
  'color-mix(in srgb, var(--green) 60%, var(--cyan))',
  'color-mix(in srgb, var(--red) 65%, var(--purple))',
  'color-mix(in srgb, var(--yellow) 65%, var(--orange))',
] as const;

function seriesColors(ids: readonly string[]): Map<string, string> {
  const colors = new Map<string, string>();
  for (const id of [...new Set(ids)].sort()) {
    if (colors.size < SERIES_COLORS.length) {
      colors.set(id, SERIES_COLORS[colors.size] ?? SERIES_COLORS[0]);
      continue;
    }
    const base =
      DRACULA_BASE_COLORS[colors.size % DRACULA_BASE_COLORS.length] ??
      DRACULA_BASE_COLORS[0];
    const weight = 52 + ((Math.floor(colors.size / 7) * 9) % 36);
    colors.set(id, `color-mix(in srgb, ${base} ${weight}%, var(--fg))`);
  }
  return colors;
}

type Measurement =
  | 'limit'
  | 'cost'
  | 'totalTokens'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens';

const MEASUREMENTS: ReadonlyArray<{ value: Measurement; label: string }> = [
  { value: 'limit', label: 'Limit usage %' },
  { value: 'cost', label: 'API-equivalent cost' },
  { value: 'totalTokens', label: 'Total tokens' },
  { value: 'inputTokens', label: 'Input tokens' },
  { value: 'outputTokens', label: 'Output tokens' },
  { value: 'cacheReadTokens', label: 'Cache read tokens' },
  { value: 'cacheWriteTokens', label: 'Cache write tokens' },
];

interface ChartSeries {
  id: string;
  label: string;
  color: string;
  values: number[];
  resets?: boolean[];
  resetsAt?: number;
}

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

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours < 24) return `${hours}h${remaining ? ` ${remaining}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
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

export function clampUsagePointIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function spendValue(point: UsageSpendPoint, measurement: Measurement): number {
  if (measurement === 'cost') return point.costUsd;
  if (measurement === 'inputTokens') return point.inputTokens;
  if (measurement === 'outputTokens') return point.outputTokens;
  if (measurement === 'cacheReadTokens') return point.cacheReadTokens;
  if (measurement === 'cacheWriteTokens') return point.cacheWriteTokens;
  return point.totalTokens;
}

export function analyticsSeries(
  data: UsageHistoryResponse,
  measurement: Measurement,
  cumulative: boolean,
  preferences: ReturnType<typeof useModelDisplayPreferences> = {},
): ChartSeries[] {
  if (measurement === 'limit') {
    const colors = seriesColors(data.series.map((series) => series.id));
    return data.series.map((series) => {
      const byBucket = new Map(
        series.points.map((point) => [point.bucketStart, point]),
      );
      let last = 0;
      return {
        id: series.id,
        label: `${series.limitName} ${series.windowLabel}`,
        color: colors.get(series.id) ?? SERIES_COLORS[0],
        values: data.buckets.map((bucket) => {
          const point = byBucket.get(bucket);
          if (point) last = point.usedPercent;
          return cumulative ? last : (point?.consumedPercent ?? 0);
        }),
        resets: data.buckets.map(
          (bucket) => byBucket.get(bucket)?.reset === true,
        ),
        ...(series.points.at(-1)?.resetsAt === undefined
          ? {}
          : { resetsAt: series.points.at(-1)?.resetsAt }),
      };
    });
  }
  const colors = seriesColors(data.spend.map((series) => series.id));
  return data.spend.map((series) => {
    const byBucket = new Map(
      series.points.map((point) => [point.bucketStart, point]),
    );
    let total = 0;
    return {
      id: series.id,
      label: series.label,
      color:
        modelDisplayPreference(preferences, series.provider, series.modelId)
          .color ??
        colors.get(series.id) ??
        SERIES_COLORS[0],
      values: data.buckets.map((bucket) => {
        const value = spendValue(
          byBucket.get(bucket) ?? {
            bucketStart: bucket,
            calls: 0,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
          },
          measurement,
        );
        total += value;
        return cumulative ? total : value;
      }),
    };
  });
}

function formatMetric(value: number, measurement: Measurement): string {
  if (measurement === 'limit') return `${value.toFixed(value < 10 ? 1 : 0)}%`;
  if (measurement === 'cost')
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: value < 10 ? 2 : 0,
      maximumFractionDigits: value < 1 ? 3 : 2,
    }).format(value);
  return new Intl.NumberFormat(undefined, { notation: 'compact' }).format(
    value,
  );
}

function formatPeriod(start: number, end: number): string {
  const sameDay =
    new Date(start).toDateString() === new Date(end - 1).toDateString();
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  });
  if (sameDay) return formatter.format(start);
  return `${formatter.format(start)} – ${formatter.format(end - 1)}`;
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

function formatBucket(timestamp: number, range: UsageHistoryRange): string {
  return new Intl.DateTimeFormat(undefined, {
    ...(range === '24h'
      ? { hour: 'numeric' }
      : { month: 'short', day: 'numeric' }),
  }).format(timestamp);
}

function SeriesSelector({
  series,
  selected,
  onChange,
}: {
  series: readonly ChartSeries[];
  selected: readonly string[] | undefined;
  onChange: (value: string[] | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const all = selected === undefined;
  const selectedSet = new Set(selected);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);
  const toggle = (id: string, checked: boolean) => {
    const current = all
      ? series.map((item) => item.id)
      : series
          .filter((item) => selectedSet.has(item.id))
          .map((item) => item.id);
    const next = checked
      ? [...new Set([...current, id])]
      : current.filter((item) => item !== id);
    if (next.length === 0) return;
    onChange(next.length === series.length ? undefined : next);
  };
  return (
    <div className={styles.seriesSelector} ref={containerRef}>
      <button
        type="button"
        ref={buttonRef}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="usage-series-menu"
        onClick={() => setOpen((value) => !value)}
      >
        {all ? 'All series' : `${selected.length} of ${series.length} series`}
      </button>
      {open && (
        <fieldset id="usage-series-menu" className={styles.seriesMenu}>
          <legend className="sr-only">Visible usage series</legend>
          <label>
            <input
              type="checkbox"
              checked={all}
              onChange={() => onChange(undefined)}
            />
            <i aria-hidden="true" />
            All
          </label>
          {series.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={all || selectedSet.has(item.id)}
                onChange={(event) =>
                  toggle(item.id, event.currentTarget.checked)
                }
              />
              <i aria-hidden="true" style={{ background: item.color }} />
              {item.label}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

function CombinedChart({
  buckets,
  series,
  range,
  measurement,
  cumulative,
}: {
  buckets: readonly number[];
  series: readonly ChartSeries[];
  range: UsageHistoryRange;
  measurement: Measurement;
  cumulative: boolean;
}) {
  const [activeIndex, setActiveIndex] = useState(() => buckets.length - 1);
  const [hovered, setHovered] = useState(false);
  const selectedIndex = clampUsagePointIndex(activeIndex, buckets.length);
  const maxValue = Math.max(
    measurement === 'limit' && cumulative ? 100 : 0,
    ...series.flatMap((item) => item.values),
    1,
  );
  const x = (index: number) =>
    ((index + 0.5) / Math.max(1, buckets.length)) * 100;
  const y = (value: number) => 36 - (value / maxValue) * 32;
  const selectFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setActiveIndex(
      clampUsagePointIndex(
        Math.floor(
          ((event.clientX - bounds.left) / Math.max(1, bounds.width)) *
            buckets.length,
        ),
        buckets.length,
      ),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setActiveIndex(
      clampUsagePointIndex(
        selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1),
        buckets.length,
      ),
    );
  };
  if (series.length === 0)
    return <div className={styles.emptyChart}>No activity in this period.</div>;
  const groupWidth = 78 / Math.max(1, buckets.length);
  const barWidth = groupWidth / Math.max(1, series.length);
  const axisStep = Math.max(1, Math.ceil(buckets.length / 6));
  const axisIndexes = buckets
    .map((_, index) => index)
    .filter((index) => index % axisStep === 0 || index === buckets.length - 1);
  return (
    <div
      className={styles.combinedChart}
      tabIndex={0}
      role="slider"
      aria-label="Usage analytics interval"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, buckets.length - 1)}
      aria-valuenow={selectedIndex}
      aria-valuetext={`${formatBucket(buckets[selectedIndex] ?? 0, range)}. ${series
        .map(
          (item) =>
            `${item.label} ${formatMetric(item.values[selectedIndex] ?? 0, measurement)}`,
        )
        .join(', ')}`}
      onKeyDown={onKeyDown}
    >
      <div className={styles.yAxis} aria-hidden="true">
        <span>{formatMetric(maxValue, measurement)}</span>
        <span>{formatMetric(maxValue / 2, measurement)}</span>
        <span>{formatMetric(0, measurement)}</span>
      </div>
      <div
        className={styles.plotArea}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerMove={selectFromPointer}
      >
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
          <path className={styles.gridLine} d="M0,4 L100,4" />
          <path className={styles.gridLine} d="M0,20 L100,20" />
          <path className={styles.gridLine} d="M0,36 L100,36" />
          {cumulative
            ? series.map((item) => (
                <path
                  className={styles.measureLine}
                  stroke={item.color}
                  d={item.values
                    .map(
                      (value, index) =>
                        `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`,
                    )
                    .join(' ')}
                  key={item.id}
                />
              ))
            : series.flatMap((item, seriesIndex) =>
                item.values.map((value, index) => (
                  <rect
                    className={styles.measureBar}
                    fill={item.color}
                    x={x(index) - groupWidth / 2 + seriesIndex * barWidth}
                    y={y(value)}
                    width={Math.max(0.15, barWidth - 0.12)}
                    height={Math.max(0, 36 - y(value))}
                    key={`${item.id}-${buckets[index]}`}
                  />
                )),
              )}
          {buckets.map((bucket, index) =>
            series.some((item) => item.resets?.[index]) ? (
              <path
                className={styles.resetGuide}
                d={`M${x(index)},4 L${x(index)},36`}
                key={`reset-${bucket}`}
              />
            ) : null,
          )}
          {hovered && (
            <path
              className={styles.activeGuide}
              d={`M${x(selectedIndex)},4 L${x(selectedIndex)},36`}
            />
          )}
        </svg>
        {hovered && (
          <div
            className={styles.chartTooltip}
            style={{ left: `${Math.min(82, Math.max(4, x(selectedIndex)))}%` }}
            role="status"
          >
            <strong>
              {formatBucket(buckets[selectedIndex] ?? 0, range)}
              {series.some((item) => item.resets?.[selectedIndex]) && (
                <em>reset</em>
              )}
            </strong>
            {series.map((item) => (
              <span className={styles.tooltipSeries} key={item.id}>
                <i style={{ background: item.color }} />
                {item.label}
                <b>
                  {formatMetric(item.values[selectedIndex] ?? 0, measurement)}
                </b>
              </span>
            ))}
          </div>
        )}
      </div>
      <div
        className={styles.xAxis}
        style={{ gridTemplateColumns: `repeat(${buckets.length}, 1fr)` }}
        aria-hidden="true"
      >
        {axisIndexes.map((index) => (
          <span style={{ gridColumn: index + 1 }} key={buckets[index]}>
            {formatBucket(buckets[index] ?? 0, range)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function UsageAnalyticsPanel() {
  const [range, setRange] = useState<UsageHistoryRange>('24h');
  const [anchor, setAnchor] = useState(() => Date.now());
  const [page, setPage] = useState(0);
  const [measurement, setMeasurement] = useState<Measurement>('limit');
  const [cumulative, setCumulative] = useState(false);
  const [selected, setSelected] = useState<string[] | undefined>();
  const modelDisplayPreferences = useModelDisplayPreferences();
  const before = anchor - page * RANGE_MS[range];
  const options = usageHistoryQueryOptions(dashboardHttpClient, range, before);
  const history = useQuery(options);
  const data = history.data;
  const allSeries = useMemo(
    () =>
      data
        ? analyticsSeries(
            data,
            measurement,
            cumulative,
            modelDisplayPreferences,
          )
        : [],
    [cumulative, data, measurement, modelDisplayPreferences],
  );
  const availableIds = useMemo(
    () => new Set(allSeries.map((item) => item.id)),
    [allSeries],
  );
  useEffect(() => {
    if (!selected) return;
    const retained = selected.filter((id) => availableIds.has(id));
    if (retained.length === 0) setSelected(undefined);
    else if (retained.length !== selected.length) setSelected(retained);
  }, [availableIds, selected]);
  const visibleSeries = selected
    ? allSeries.filter((item) => selected.includes(item.id))
    : allSeries;
  const periodStart = data?.periodStart ?? before - RANGE_MS[range];
  const periodEnd = data?.periodEnd ?? before;
  const seriesTotal = (item: ChartSeries) =>
    cumulative
      ? (item.values.at(-1) ?? 0)
      : item.values.reduce((sum, value) => sum + value, 0);
  const total = visibleSeries.reduce((sum, item) => sum + seriesTotal(item), 0);
  return (
    <div className={styles.analytics}>
      <div className={styles.periodToolbar}>
        <fieldset className={styles.rangeSelector}>
          <legend className="sr-only">Usage history range</legend>
          {RANGES.map((item) => (
            <button
              type="button"
              aria-pressed={range === item.range}
              onClick={() => {
                setRange(item.range);
                setPage(0);
                setAnchor(Date.now());
              }}
              key={item.range}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
        <div className={styles.periodPager}>
          <button type="button" onClick={() => setPage((value) => value + 1)}>
            ‹ <span>Previous</span>
          </button>
          <strong>{formatPeriod(periodStart, periodEnd)}</strong>
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            <span>Next</span> ›
          </button>
        </div>
      </div>
      <div className={styles.measureToolbar}>
        <fieldset className={styles.measurementRadios}>
          <legend className="sr-only">Measurement</legend>
          {MEASUREMENTS.map((item) => (
            <label key={item.value}>
              <input
                type="radio"
                name="usage-measurement"
                value={item.value}
                checked={measurement === item.value}
                onChange={() => {
                  setMeasurement(item.value);
                  setSelected(undefined);
                }}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </fieldset>
        <label className={styles.measurementSelect}>
          <span className="sr-only">Measurement</span>
          <select
            value={measurement}
            onChange={(event) => {
              setMeasurement(event.currentTarget.value as Measurement);
              setSelected(undefined);
            }}
          >
            {MEASUREMENTS.map((item) => (
              <option value={item.value} key={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <SeriesSelector
          series={allSeries}
          selected={selected}
          onChange={setSelected}
        />
        <button
          type="button"
          className={styles.cumulativeToggle}
          aria-pressed={cumulative}
          onClick={() => setCumulative((value) => !value)}
        >
          Cumulative
        </button>
      </div>
      {data && measurement !== 'limit' && (
        <section
          className={styles.metricSummary}
          aria-labelledby="usage-period-total-label"
        >
          <span className={styles.totalValue}>
            <h3 id="usage-period-total-label">Period total</h3>
            <strong>{formatMetric(total, measurement)}</strong>
          </span>
          <span className={styles.seriesTotals}>
            {visibleSeries.map((item) => (
              <span className={styles.seriesTotal} key={item.id}>
                <i style={{ background: item.color }} />
                <span>{item.label}</span>
                <strong>{formatMetric(seriesTotal(item), measurement)}</strong>
              </span>
            ))}
          </span>
        </section>
      )}
      {history.isPending && <p className={styles.status}>Loading history…</p>}
      {history.isError && (
        <p className={styles.status} role="alert">
          Usage history is unavailable.
        </p>
      )}
      {data && (
        <section className={styles.graphCard}>
          <CombinedChart
            buckets={data.buckets}
            series={visibleSeries}
            range={range}
            measurement={measurement}
            cumulative={cumulative}
          />
          {measurement === 'limit' && page === 0 && (
            <div className={styles.projections}>
              {data.series
                .filter((item) =>
                  visibleSeries.some((series) => series.id === item.id),
                )
                .filter((item) => item.burnRate)
                .map((item) => (
                  <p className={styles.projectionItem} key={item.id}>
                    <strong>{item.windowLabel}</strong>{' '}
                    {item.burnRate?.percentPerHour.toFixed(2)}%/h.{' '}
                    {item.burnRate
                      ? usageProjection(item.burnRate, data.generatedAt)
                      : null}
                  </p>
                ))}
            </div>
          )}
          <div className={styles.legend}>
            {visibleSeries.map((item) => (
              <span className={styles.legendItem} key={item.id}>
                <i style={{ background: item.color }} />
                <span>{item.label}</span>
                {item.resetsAt !== undefined && (
                  <em className={styles.legendReset}>
                    reset {formatTimestamp(item.resetsAt)}
                  </em>
                )}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
