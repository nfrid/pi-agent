import type { ReactNode } from 'react';

/** Shared activity-list heading and disclosure control. */
export function ActivityCollapsibleSection({
  title,
  expanded,
  onToggle,
  totalCount,
  visibleCount,
  summary,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  totalCount: number;
  visibleCount: number;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const hiddenCount = Math.max(0, totalCount - visibleCount);
  const canToggle = expanded || totalCount > visibleCount;
  const noun = title.toLowerCase();
  return (
    <section
      className="activity-panel-section"
      aria-label={title}
      tabIndex={-1}
    >
      <h2 className="activity-panel-header activity-panel-header-toggle">
        <button
          type="button"
          aria-label={
            expanded ? `Show fewer ${noun}` : `Show all ${totalCount} ${noun}`
          }
          aria-expanded={expanded}
          disabled={!canToggle}
          onClick={onToggle}
        >
          <span className="activity-panel-heading-title">
            <span>{title}</span>
            {!expanded && hiddenCount > 0 && (
              <span className="activity-panel-hidden-chip" aria-hidden="true">
                {hiddenCount} more
              </span>
            )}
          </span>
          {summary}
        </button>
      </h2>
      <div className="activity-panel-rows">{children}</div>
    </section>
  );
}
