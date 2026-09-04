import type { CodexServiceTier } from '@pi-dashboard/protocol';

export function ServiceTierIcon({
  tier,
  decorative = false,
}: {
  tier: CodexServiceTier;
  decorative?: boolean;
}) {
  const bolts = tier === 'ultrafast' ? 2 : 1;
  const label = tier === 'fast' ? 'Fast' : 'Ultrafast';
  return (
    <span
      className="service-tier-icon"
      data-service-tier={tier}
      role="img"
      aria-hidden={decorative || undefined}
      aria-label={label}
      title={decorative ? undefined : label}
    >
      <svg viewBox={bolts === 1 ? '0 0 24 24' : '0 0 42 24'} aria-hidden="true">
        <path d="M13 2 3 14h9l-1 8 10-12h-9z" />
        {bolts === 2 && <path d="M31 2 21 14h9l-1 8 10-12h-9z" />}
      </svg>
    </span>
  );
}
