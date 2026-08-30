import { useId } from 'react';
import type { TranscriptModelItem } from '../../transcript';
import { toolStreamMetadataLabel, toolStreamSummary } from './activity';
import { TranscriptEntry } from './entries';

function toolDescriptor(item: TranscriptModelItem) {
  const tool = item.tool;
  if (!tool) return undefined;
  return {
    name: tool.name,
    args: tool.arguments,
    status: tool.status,
    isError: tool.isError,
    result: tool.result,
    data: tool.data,
  };
}

export function TranscriptToolStream({
  items,
  cwd,
  expanded,
  onToggle,
  captureScrollAnchor,
  timestampOverride,
}: {
  items: readonly TranscriptModelItem[];
  cwd?: string;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  captureScrollAnchor?: (key: string) => void;
  timestampOverride?: number | string;
}) {
  const first = items[0];
  const streamKey = first?.key ?? 'tool-stream';
  const tools = items.flatMap((item) => {
    const tool = toolDescriptor(item);
    return tool ? [tool] : [];
  });
  const summary = toolStreamSummary(tools);
  const metadata = toolStreamMetadataLabel(tools);
  const detailId = useId();
  const visibleItems = expanded ? items : items.slice(-3);
  const earlierLabel = `${summary.earlierToolCount} earlier call${summary.earlierToolCount === 1 ? '' : 's'}`;
  const toggle = () => {
    captureScrollAnchor?.(streamKey);
    onToggle(!expanded);
  };

  return (
    <section
      className={`transcript-tool-stream${expanded ? ' transcript-tool-stream-expanded' : ''}`}
      data-transcript-key={streamKey}
      aria-label="Tool calls"
    >
      <div className="tool-stream-meta" id={`${detailId}-meta`}>
        {summary.earlierToolCount > 0 ? (
          <button
            type="button"
            className="tool-stream-toggle"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={`${expanded ? 'Hide' : 'Show'} ${earlierLabel} · ${metadata}`}
            onClick={toggle}
          >
            <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
            {expanded ? 'Hide' : 'Show'} {earlierLabel}
          </button>
        ) : null}
        <small className="tool-stream-metadata" title={metadata}>
          {metadata}
        </small>
      </div>
      <div
        className="tool-stream-items"
        id={detailId}
        aria-describedby={`${detailId}-meta`}
      >
        {visibleItems.map((item) => (
          <div key={item.key}>
            <TranscriptEntry
              item={item}
              cwd={cwd}
              timestampOverride={timestampOverride}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
