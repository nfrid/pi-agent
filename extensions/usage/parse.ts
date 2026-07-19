import type {
  AppServerResponse,
  BackendPayload,
  UsageReport,
  UsageSnapshot,
  UsageWindow,
} from './types';

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function normalizeKey(value: string | undefined): string | undefined {
  const normalized = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || undefined;
}

export function hasHeader(
  headers: Record<string, string>,
  name: string,
): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function normalizeBackendWindow(value: unknown): UsageWindow | undefined {
  const window = asRecord(value);
  if (!window) return undefined;
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const limitSeconds = asNumber(window.limit_window_seconds);
  return {
    usedPercent,
    windowMinutes: limitSeconds ? Math.ceil(limitSeconds / 60) : undefined,
    resetsAt: asNumber(window.reset_at),
  };
}

function normalizeBackendSnapshot(
  limitId: string,
  limitName: string | undefined,
  rateLimit: unknown,
): UsageSnapshot | undefined {
  const details = asRecord(rateLimit);
  if (!details) return undefined;
  const primary = normalizeBackendWindow(details.primary_window);
  const secondary = normalizeBackendWindow(details.secondary_window);
  if (!primary && !secondary) return undefined;
  return { limitId, limitName, primary, secondary };
}

export function normalizeBackendPayload(payload: BackendPayload): UsageReport {
  const snapshots: UsageSnapshot[] = [];
  const primary = normalizeBackendSnapshot(
    'codex',
    undefined,
    payload.rate_limit,
  );
  if (primary) snapshots.push(primary);

  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : [];
  for (const item of additional) {
    const limit = asRecord(item);
    if (!limit) continue;
    const limitId =
      asString(limit.metered_feature) ?? asString(limit.limit_name) ?? 'codex';
    const snapshot = normalizeBackendSnapshot(
      limitId,
      asString(limit.limit_name),
      limit.rate_limit,
    );
    if (snapshot) snapshots.push(snapshot);
  }

  if (snapshots.length === 0) {
    throw new Error('Codex usage endpoint returned no rate-limit windows.');
  }
  return { capturedAt: Date.now(), snapshots };
}

function normalizeAppServerWindow(value: unknown): UsageWindow | undefined {
  const window = asRecord(value);
  if (!window) return undefined;
  const usedPercent = asNumber(window.usedPercent);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    windowMinutes: asNumber(window.windowDurationMins),
    resetsAt: asNumber(window.resetsAt),
  };
}

function normalizeAppServerSnapshot(
  value: unknown,
  fallbackId: string,
): UsageSnapshot | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const primary = normalizeAppServerWindow(raw.primary);
  const secondary = normalizeAppServerWindow(raw.secondary);
  if (!primary && !secondary) return undefined;
  return {
    limitId: asString(raw.limitId) ?? fallbackId,
    limitName: asString(raw.limitName),
    primary,
    secondary,
  };
}

export function normalizeAppServerResponse(
  response: AppServerResponse,
): UsageReport {
  const snapshots: UsageSnapshot[] = [];
  const add = (value: unknown, fallbackId: string) => {
    const snapshot = normalizeAppServerSnapshot(value, fallbackId);
    if (!snapshot) return;
    const index = snapshots.findIndex(
      (item) => item.limitId === snapshot.limitId,
    );
    if (index >= 0) {
      const existing = snapshots[index];
      if (!existing) return;
      snapshots[index] = {
        ...existing,
        ...snapshot,
        limitName: snapshot.limitName ?? existing.limitName,
        primary: snapshot.primary ?? existing.primary,
        secondary: snapshot.secondary ?? existing.secondary,
      };
    } else snapshots.push(snapshot);
  };

  add(response.rateLimits, 'codex');
  const byId = asRecord(response.rateLimitsByLimitId);
  if (byId) {
    for (const [limitId, value] of Object.entries(byId)) add(value, limitId);
  }

  if (snapshots.length === 0) {
    throw new Error('Codex app-server returned no rate-limit windows.');
  }
  return { capturedAt: Date.now(), snapshots };
}
