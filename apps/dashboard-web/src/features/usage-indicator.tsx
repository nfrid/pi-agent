import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useEffect, useRef, useState } from 'react';
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

function resetTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 100_000_000_000 ? value * 1_000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric))
      return numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
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
    const reset = resetTime(value[key]);
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
  const resetAfterSeconds = numberFrom(source, [
    'resetAfterSeconds',
    'reset_after_seconds',
    'resetInSeconds',
    'reset_in_seconds',
  ]);
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
  const milliseconds =
    resetsAt !== undefined
      ? resetsAt - now
      : resetAfterSeconds !== undefined
        ? resetAfterSeconds * 1_000
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

function WindowSummary({
  window,
  now,
  compact = false,
}: {
  window: UsageWindow;
  now: number;
  compact?: boolean;
}) {
  const percent = Math.round(window.usedPercent);
  const tone = usageTone(window.usedPercent);
  const countdown = formatResetCountdown(
    window.resetsAt,
    now,
    window.resetAfterSeconds,
  );
  return (
    <span
      className={`${styles.window} ${compact ? styles.compactWindow : ''}`}
      data-tone={tone}
      data-window={window.kind}
    >
      <i className={styles.dot} aria-hidden="true" />
      <span className={styles.windowLabel}>{window.label}</span>
      <span className={styles.percent}>{percent}%</span>
      <span className={styles.reset}>{countdown ?? 'reset unknown'}</span>
    </span>
  );
}

export function UsageCapsule({ usage }: { usage: BrowserSnapshot['usage'] }) {
  const limits = parseUsage(usage);
  const first = limits[0];
  const windows = first
    ? [first.primary, first.secondary].filter((window): window is UsageWindow =>
        Boolean(window),
      )
    : [];
  const urgent = selectUrgentWindow(windows);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const capsuleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!capsuleRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!first || !urgent) return null;
  return (
    <div
      className={`${styles.capsule} usage-capsule ${styles.sidebar}`}
      ref={capsuleRef}
    >
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls="usage-capsule-details"
        aria-label={`Usage: ${windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(', ')}`}
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
        <strong>{first.name} usage</strong>
        {windows.map((window) => (
          <WindowSummary key={window.kind} window={window} now={now} compact />
        ))}
      </div>
    </div>
  );
}
