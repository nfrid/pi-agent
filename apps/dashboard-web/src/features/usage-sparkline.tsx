import type { UsageHistoryPoint } from '@pi-dashboard/protocol';
import styles from './usage-analytics.module.css';

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
