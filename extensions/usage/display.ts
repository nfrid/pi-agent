import type {
  ExtensionContext,
  ThemeColor,
} from '@earendil-works/pi-coding-agent';
import { CODEX_PROVIDER_ID } from './constants';
import { clampPercent, normalizeKey } from './parse';
import type { PiModel, UsageReport, UsageSnapshot } from './types';

export function isCodexModel(
  model: ExtensionContext['model'],
): model is PiModel {
  return model?.provider === CODEX_PROVIDER_ID;
}

export function modelKeys(model: PiModel): Set<string> {
  const keys = new Set<string>();
  for (const raw of [model.id, model.name]) {
    const key = normalizeKey(raw);
    if (!key) continue;
    keys.add(key);
    const codexIndex = key.indexOf('codex');
    if (codexIndex >= 0) keys.add(key.slice(codexIndex));
  }
  return keys;
}

export function snapshotKeys(snapshot: UsageSnapshot): string[] {
  return [
    normalizeKey(snapshot.limitId),
    normalizeKey(snapshot.limitName),
  ].filter((key): key is string => Boolean(key));
}

export function isPrimarySnapshot(snapshot: UsageSnapshot): boolean {
  return snapshotKeys(snapshot).includes('codex');
}

export function selectSnapshot(
  report: UsageReport,
  model: PiModel,
): UsageSnapshot | undefined {
  const keys = modelKeys(model);
  const exact = report.snapshots.find((snapshot) =>
    snapshotKeys(snapshot).some((key) => keys.has(key)),
  );
  return (
    exact ?? report.snapshots.find(isPrimarySnapshot) ?? report.snapshots[0]
  );
}

function usageToColor(percent: number): ThemeColor {
  if (percent > 90) return 'error';
  if (percent > 70) return 'warning';
  if (percent > 50) return 'success';
  return 'dim';
}

function resetTimeToMs(resetsAt: number): number {
  return resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000;
}

function formatDurationLeft(resetsAt: number, now = Date.now()): string {
  const totalMinutes = Math.max(
    0,
    Math.ceil((resetTimeToMs(resetsAt) - now) / 60_000),
  );
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours > 0 ? `${hours}h` : ''}`;
  if (hours > 0) return `${hours}h ${minutes > 0 ? `${minutes}m` : ''}`;
  return `${minutes}m`;
}

const DISABLE_LABELS = true;

function formatUsagePart(
  label: string,
  percent: number,
  resetsAt: number | undefined,
  theme: ExtensionContext['ui']['theme'],
): string {
  const reset = resetsAt ? ` ^${formatDurationLeft(resetsAt)}` : '';
  return `${DISABLE_LABELS ? '' : `${theme.fg('dim', label)} `}${theme.fg(
    usageToColor(percent),
    `${percent}%`,
  )}${theme.italic(theme.fg('muted', reset))}`;
}

export function formatUsage(
  report: UsageReport,
  ctx: ExtensionContext,
): string {
  const theme = ctx.ui.theme;
  const unavailable = theme.fg('error', 'usage unavailable');
  const model = ctx.model;
  if (!model) return unavailable;
  const snapshot = selectSnapshot(report, model);
  if (!snapshot) return unavailable;

  const parts: string[] = [];
  if (snapshot.primary) {
    const percent = Math.round(clampPercent(snapshot.primary.usedPercent));
    parts.push(
      formatUsagePart('5h', percent, snapshot.primary.resetsAt, theme),
    );
  }
  if (snapshot.secondary) {
    const percent = Math.round(clampPercent(snapshot.secondary.usedPercent));
    parts.push(
      formatUsagePart('wk', percent, snapshot.secondary.resetsAt, theme),
    );
  }
  return parts.join(theme.fg('dim', ' ⋅ '));
}
