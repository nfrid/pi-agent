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

export function DashboardTime({
  timestamp,
  context = 'transcript',
  className,
}: {
  timestamp: DashboardTimestamp | undefined;
  context?: 'transcript' | 'sidebar';
  className?: string;
}) {
  const date = timestampDate(timestamp);
  const text = formatDashboardTimestamp(timestamp, context);
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
