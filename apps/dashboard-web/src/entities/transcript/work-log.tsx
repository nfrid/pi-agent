import { toolStreamDurationLabel } from './activity';
import { TranscriptDisclosureIcon } from './disclosure-icon';

export function TranscriptWorkLog({
  rowKey,
  durationMs,
  actionCount,
  expanded,
  onToggle,
}: {
  rowKey: string;
  durationMs: number;
  actionCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="transcript-work-log" data-transcript-key={rowKey}>
      <button
        type="button"
        className="transcript-work-log-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <TranscriptDisclosureIcon expanded={expanded} />
        <span>Work log</span>
        <small>
          {toolStreamDurationLabel(durationMs)} · {actionCount}{' '}
          {actionCount === 1 ? 'action' : 'actions'}
        </small>
      </button>
    </section>
  );
}
