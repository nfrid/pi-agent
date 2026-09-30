import { toolStreamDurationLabel } from './activity';
import { TranscriptDisclosureIcon } from './disclosure-icon';

export function TranscriptWorkLog({
  rowKey,
  durationMs,
  actionCount,
  expanded,
  loading = false,
  onToggle,
}: {
  rowKey: string;
  durationMs: number;
  actionCount?: number;
  expanded: boolean;
  loading?: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="transcript-work-log" data-transcript-key={rowKey}>
      <button
        type="button"
        className="transcript-work-log-toggle"
        aria-expanded={expanded}
        aria-busy={loading || undefined}
        onClick={onToggle}
      >
        <TranscriptDisclosureIcon expanded={expanded} />
        <span>Work log</span>
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
  );
}
