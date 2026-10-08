import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { toolStreamDurationLabel } from './activity';
import { TranscriptDisclosureIcon } from './disclosure-icon';

export function TranscriptWorkLog({
  rowKey,
  durationMs,
  actionCount,
  expanded,
  loading = false,
  onToggle,
  children,
  virtualized = false,
}: {
  rowKey: string;
  durationMs: number;
  actionCount?: number;
  expanded: boolean;
  loading?: boolean;
  onToggle: () => void;
  children?: ReactNode;
  virtualized?: boolean;
}) {
  const scopeRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const update = () => {
      const height = header.getBoundingClientRect().height;
      scopeRef.current?.style.setProperty(
        '--transcript-work-log-header-height',
        `${height}px`,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={scopeRef}
      className={`transcript-work-log-scope${expanded ? ' transcript-work-log-scope-expanded' : ''}${virtualized ? ' transcript-work-log-scope-virtualized' : ''}`}
    >
      <section
        ref={headerRef}
        className="transcript-work-log"
        data-transcript-key={rowKey}
      >
        <button
          type="button"
          className="transcript-work-log-toggle"
          aria-expanded={expanded}
          aria-busy={loading || undefined}
          onClick={onToggle}
        >
          <TranscriptDisclosureIcon expanded={expanded} />
          <span>Worked for</span>
          <small>
            {toolStreamDurationLabel(durationMs)}
            {actionCount === undefined
              ? loading
                ? ' · Loading history…'
                : ''
              : ` · ${actionCount} ${actionCount === 1 ? 'action' : 'actions'}`}
          </small>
        </button>
      </section>
      {expanded ? (
        <div className="transcript-work-log-history">{children}</div>
      ) : null}
    </section>
  );
}
