import {
  dashboardHttpClient,
  usageHistoryQueryOptions,
} from '@pi-dashboard/client';
import {
  type BrowserSnapshot,
  boundedUsageResetAfterSeconds,
  parseUsageTimestamp,
  type UsageHistoryResponse,
} from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useDashboardSurfaces } from './dashboard-surface-context';
import { UsageSparkline } from './usage-analytics';
import styles from './usage-indicator.module.css';

export type UsageWindow = {
  kind: 'primary' | 'secondary';
  label: string;
  usedPercent: number;
  resetsAt?: number;
  resetAfterSeconds?: number;
};

export type UsageLimit = {
  id: string;
  name: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function numberFrom(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const number = finiteNumber(value[key]);
    if (number !== undefined) return number;
  }
  return undefined;
}

function resetFrom(value: Record<string, unknown>): number | undefined {
  for (const key of [
    'resetsAt',
    'resetAt',
    'reset_at',
    'resets_at',
    'resetTime',
    'reset_time',
  ]) {
    const reset = parseUsageTimestamp(value[key]);
    if (reset !== undefined) return reset;
  }
  return undefined;
}

function windowLabel(
  value: Record<string, unknown>,
  kind: 'primary' | 'secondary',
): string {
  const explicit = value.windowLabel ?? value.window_label ?? value.label;
  if (typeof explicit === 'string' && explicit.trim()) {
    const normalized = explicit.trim();
    if (/^weekly$/iu.test(normalized)) return 'wk';
    if (/^5\s*hours?$/iu.test(normalized)) return '5h';
    return normalized;
  }
  const minutes =
    numberFrom(value, [
      'windowMinutes',
      'windowDurationMins',
      'window_minutes',
      'window_duration_mins',
    ]) ??
    (numberFrom(value, [
      'windowSeconds',
      'window_seconds',
      'limitWindowSeconds',
      'limit_window_seconds',
    ]) ?? 0) / 60;
  if (minutes === 300) return '5h';
  if (minutes === 10_080) return 'wk';
  if (minutes !== undefined && minutes > 0) {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return kind === 'primary' ? 'primary' : 'secondary';
}

function parseWindow(
  value: unknown,
  kind: 'primary' | 'secondary',
): UsageWindow | undefined {
  const source = record(value);
  if (!source) return undefined;
  const usedPercent = numberFrom(source, ['usedPercent', 'used_percent']);
  if (usedPercent === undefined) return undefined;
  const resetAfterSeconds = boundedUsageResetAfterSeconds(
    numberFrom(source, [
      'resetAfterSeconds',
      'reset_after_seconds',
      'resetInSeconds',
      'reset_in_seconds',
    ]),
  );
  return {
    kind,
    label: windowLabel(source, kind),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAt: resetFrom(source),
    ...(resetAfterSeconds === undefined ? {} : { resetAfterSeconds }),
  };
}

/** Converts provider variants into the shape shared by dashboard usage views. */
export function parseUsage(usage: unknown): UsageLimit[] {
  const root = record(usage);
  const nested = record(root?.usage);
  const source = root?.snapshots
    ? root
    : nested?.snapshots
      ? nested
      : undefined;
  if (!source || !Array.isArray(source.snapshots)) return [];
  return source.snapshots.flatMap((item, index) => {
    const snapshot = record(item);
    if (!snapshot) return [];
    const id = String(snapshot.limitId ?? snapshot.id ?? index);
    const name = String(snapshot.limitName ?? snapshot.name ?? id);
    const primary = parseWindow(
      snapshot.primary ?? snapshot.primaryWindow ?? snapshot.primary_window,
      'primary',
    );
    const secondary = parseWindow(
      snapshot.secondary ??
        snapshot.secondaryWindow ??
        snapshot.secondary_window,
      'secondary',
    );
    return primary || secondary ? [{ id, name, primary, secondary }] : [];
  });
}

export function usageTone(
  percent: number,
): 'neutral' | 'green' | 'amber' | 'red' {
  if (percent < 50) return 'neutral';
  if (percent <= 70) return 'green';
  if (percent <= 90) return 'amber';
  return 'red';
}

export function selectUrgentWindow(
  windows: readonly UsageWindow[],
): UsageWindow | undefined {
  return [...windows].sort((a, b) => {
    if (b.usedPercent !== a.usedPercent) return b.usedPercent - a.usedPercent;
    if (a.resetsAt !== undefined && b.resetsAt !== undefined)
      return a.resetsAt - b.resetsAt;
    if (a.resetsAt !== undefined) return -1;
    if (b.resetsAt !== undefined) return 1;
    return a.kind === 'primary' ? -1 : 1;
  })[0];
}

export function formatResetCountdown(
  resetsAt: number | undefined,
  now = Date.now(),
  resetAfterSeconds?: number,
): string | undefined {
  const validResetAfter = boundedUsageResetAfterSeconds(resetAfterSeconds);
  const milliseconds =
    resetsAt !== undefined
      ? resetsAt - now
      : validResetAfter !== undefined
        ? validResetAfter * 1_000
        : undefined;
  if (milliseconds === undefined) return undefined;
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  if (minutes === 0) return 'now';
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remaining = minutes % 60;
  if (days) return `in ${days}d${hours ? ` ${hours}h` : ''}`;
  if (hours) return `in ${hours}h${remaining ? ` ${remaining}m` : ''}`;
  return `in ${minutes}m`;
}

function WindowSummary({ window, now }: { window: UsageWindow; now: number }) {
  const percent = Math.round(window.usedPercent);
  const tone = usageTone(window.usedPercent);
  const countdown = formatResetCountdown(
    window.resetsAt,
    now,
    window.resetAfterSeconds,
  );
  return (
    <span className={styles.window} data-tone={tone} data-window={window.kind}>
      <i className={styles.dot} aria-hidden="true" />
      <span className={styles.windowLabel}>{window.label}</span>
      <span className={styles.percent}>{percent}%</span>
      <span className={styles.reset}>{countdown ?? 'reset unknown'}</span>
    </span>
  );
}

function limitWindows(limit: UsageLimit): UsageWindow[] {
  return [limit.primary, limit.secondary].filter(
    (window): window is UsageWindow => Boolean(window),
  );
}

export function usageLimitsWithActivity(
  limits: readonly UsageLimit[],
  history: UsageHistoryResponse | undefined,
  filterByHistory = true,
): readonly UsageLimit[] {
  if (!history || !filterByHistory) return [];
  return limits.filter((limit) =>
    limitWindows(limit).some((window) =>
      history.series.some(
        (item) => item.limitId === limit.id && item.windowKind === window.kind,
      ),
    ),
  );
}

function UsageHistoryDetails({
  limits,
  now,
  onExpand,
}: {
  limits: readonly UsageLimit[];
  now: number;
  onExpand: () => void;
}) {
  const history = useQuery(
    usageHistoryQueryOptions(dashboardHttpClient, '24h'),
  );
  const visibleLimits = usageLimitsWithActivity(
    limits,
    history.data,
    !history.isFetching && !history.isError,
  );
  return (
    <>
      {history.isPending && (
        <span className={styles.historyStatus}>Loading history…</span>
      )}
      {history.isError && (
        <span className={styles.historyStatus}>History unavailable</span>
      )}
      {visibleLimits.map((limit) => (
        <section className={styles.historyLimit} key={limit.id}>
          <strong>{limit.name} history</strong>
          {limitWindows(limit).map((window) => {
            const series = history.data?.series.find(
              (item) =>
                item.limitId === limit.id && item.windowKind === window.kind,
            );
            const countdown = formatResetCountdown(
              window.resetsAt,
              now,
              window.resetAfterSeconds,
            );
            return (
              <div className={styles.historyWindow} key={window.kind}>
                <div className={styles.historyWindowHeader}>
                  <span>{window.label}</span>
                  <span>{countdown ?? 'reset unknown'}</span>
                </div>
                <UsageSparkline
                  points={series?.points ?? []}
                  label={`${limit.name} ${window.label}`}
                />
              </div>
            );
          })}
        </section>
      ))}
      <button type="button" className={styles.expand} onClick={onExpand}>
        Open usage analytics
      </button>
    </>
  );
}

export function UsageCapsule({ usage }: { usage: BrowserSnapshot['usage'] }) {
  const limits = parseUsage(usage);
  const allWindows = limits.flatMap(limitWindows);
  const urgent = selectUrgentWindow(allWindows);
  const activeLimit = urgent
    ? limits.find((limit) => limitWindows(limit).includes(urgent))
    : undefined;
  const windows = activeLimit ? limitWindows(activeLimit) : [];
  const surfaces = useDashboardSurfaces();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const capsuleRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!capsuleRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.command-palette')) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!activeLimit || !urgent) return null;
  return (
    <div
      className={`${styles.capsule} usage-capsule ${styles.sidebar}`}
      ref={capsuleRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls="usage-capsule-details"
        aria-label={`Usage: ${limits.length > 1 ? `${activeLimit.name}, ` : ''}${windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(', ')}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.windows} aria-hidden="true">
          {windows.map((window) => (
            <span
              className={`${styles.windowWrap} ${window === urgent ? styles.urgent : ''}`}
              key={window.kind}
            >
              <WindowSummary window={window} now={now} />
            </span>
          ))}
        </span>
      </button>
      <div
        id="usage-capsule-details"
        className={styles.details}
        role="dialog"
        aria-label="Usage limits"
        hidden={!open}
      >
        {open && (
          <UsageHistoryDetails
            limits={limits}
            now={now}
            onExpand={() => {
              setOpen(false);
              triggerRef.current?.focus();
              surfaces?.open({ type: 'usage-analytics' });
            }}
          />
        )}
      </div>
    </div>
  );
}
