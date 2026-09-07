import {
  dashboardHttpClient,
  usageHistoryQueryOptions,
} from '@pi-dashboard/client';
import {
  type BrowserSnapshot,
  type UsageWindow as NormalizedUsageWindow,
  normalizeUsage,
  type UsageHistoryResponse,
  type UsageReport,
} from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useDashboardSurfaces } from './dashboard-surface-context';
import { shortcutLabel, useModifierShortcut } from './modifier-shortcuts';
import styles from './usage-indicator.module.css';
import { UsageSparkline } from './usage-sparkline';

export type UsageWindow = NormalizedUsageWindow & {
  kind: 'primary' | 'secondary';
  label: string;
};

export type UsageLimit = {
  id: string;
  name: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
};

function formatWindowLabel(
  minutes: number | undefined,
  kind: UsageWindow['kind'],
): string {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0)
    return kind;
  if (minutes === 300) return '5h';
  if (minutes === 10_080) return 'wk';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function adaptWindow(
  window: NormalizedUsageWindow | undefined,
  kind: UsageWindow['kind'],
): UsageWindow | undefined {
  return window
    ? {
        ...window,
        kind,
        label:
          window.windowLabel ?? formatWindowLabel(window.windowMinutes, kind),
      }
    : undefined;
}

/** Adapts the canonical protocol report for the footer's view model. */
export function parseUsage(usage: unknown): UsageLimit[] {
  let report: UsageReport;
  try {
    report = normalizeUsage(usage);
  } catch {
    return [];
  }
  return report.snapshots.flatMap((snapshot) => {
    const primary = adaptWindow(snapshot.primary, 'primary');
    const secondary = adaptWindow(snapshot.secondary, 'secondary');
    return primary || secondary
      ? [
          {
            id: snapshot.limitId,
            name: snapshot.limitName ?? snapshot.limitId,
            primary,
            secondary,
          },
        ]
      : [];
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
): string | undefined {
  const milliseconds = resetsAt === undefined ? undefined : resetsAt - now;
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
  const countdown = formatResetCountdown(window.resetsAt, now);
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
            const countdown = formatResetCountdown(window.resetsAt, now);
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
  const usageShortcut = { code: 'KeyU', alt: true } as const;
  const usageHint = useModifierShortcut(
    usageShortcut,
    () => surfaces?.open({ type: 'usage-analytics' }),
    Boolean(activeLimit && urgent),
  );
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
        <kbd
          className={styles.modifierHint}
          data-shortcut-visible={usageHint ? 'true' : 'false'}
        >
          {shortcutLabel(usageShortcut)}
        </kbd>
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
