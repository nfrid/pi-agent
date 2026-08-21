export type DashboardTimestamp = number | string;

export function timestampDate(
  timestamp: DashboardTimestamp | undefined,
): Date | undefined {
  if (timestamp === undefined) return undefined;
  const numeric =
    typeof timestamp === 'string' && /^\d+$/u.test(timestamp)
      ? Number(timestamp)
      : timestamp;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatDashboardTimestamp(
  timestamp: DashboardTimestamp | undefined,
  context: 'transcript' | 'sidebar' = 'transcript',
): string | undefined {
  const date = timestampDate(timestamp);
  if (!date) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    ...(context === 'sidebar' ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatRelativeDashboardTimestamp(
  timestamp: DashboardTimestamp | undefined,
  now = Date.now(),
): string | undefined {
  const date = timestampDate(timestamp);
  if (!date) return undefined;
  const delta = Math.max(0, now - date.getTime());
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: 'numeric' }),
  }).format(date);
}

export function DashboardTime({
  timestamp,
  context = 'transcript',
  className,
}: {
  timestamp: DashboardTimestamp | undefined;
  context?: 'transcript' | 'sidebar' | 'sidebar-relative';
  className?: string;
}) {
  const date = timestampDate(timestamp);
  const text =
    context === 'sidebar-relative'
      ? formatRelativeDashboardTimestamp(timestamp)
      : formatDashboardTimestamp(timestamp, context);
  if (!date || !text) return null;
  return (
    <time
      className={className}
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
    >
      {text}
    </time>
  );
}
