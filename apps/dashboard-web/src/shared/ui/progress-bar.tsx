import styles from './progress-bar.module.css';

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function ProgressBar({
  value,
  className,
  'aria-hidden': ariaHidden,
}: {
  value: number;
  className?: string;
  'aria-hidden'?: boolean;
}) {
  const trackClassName = className ?? styles.track;
  const width = `${clampUnit(value) * 100}%`;

  return (
    <span className={trackClassName} aria-hidden={ariaHidden}>
      <i className={className ? undefined : styles.fill} style={{ width }} />
    </span>
  );
}
