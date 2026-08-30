import type {
  RuntimeSnapshot,
  SessionOutlineLandmark,
} from '@pi-dashboard/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TranscriptModelItem } from '../../../transcript';
import { TranscriptEntry } from '../entries';
import {
  buildTranscriptLandmarks,
  mergeTranscriptLandmarks,
  type TranscriptLandmark,
  transcriptItemTimestamp,
} from '../landmarks';
import { TranscriptOutline } from '../outline';
import { TranscriptToolStream } from '../tool-stream';
import { buildVirtualTranscriptRows } from '../virtual-rows';
import { useVirtualTranscriptScrollRestoration } from '../virtual-scroll';
import { LiveCompactionEvent, LivePauseEvent } from './live-events';

export function VirtualizedTranscript({
  items,
  open,
  setOpen,
  runtime,
  outline,
  onJumpToLandmark,
  tailScrollRequest,
  outlineOpen,
  onOutlineOpenChange,
  onBeforeScroll,
  pendingJumpKey,
  onPendingJumpHandled,
  scrollElementRef,
}: {
  items: readonly TranscriptModelItem[];
  open: ReadonlySet<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
  runtime?: RuntimeSnapshot;
  outline?: readonly SessionOutlineLandmark[];
  onJumpToLandmark?: (
    landmark: SessionOutlineLandmark,
  ) => Promise<boolean> | boolean;
  tailScrollRequest?: number;
  outlineOpen?: boolean;
  onOutlineOpenChange?: (open: boolean) => void;
  onBeforeScroll?: () => void;
  /** A jump requested before a regular-to-virtualized renderer transition. */
  pendingJumpKey?: string;
  onPendingJumpHandled?: () => void;
  scrollElementRef: RefObject<HTMLDivElement | null>;
}) {
  const rows = useMemo(() => buildVirtualTranscriptRows(items), [items]);
  const virtualizerRef = useRef<HTMLDivElement>(null);
  const affectedRowKeyRef = useRef<string | undefined>(undefined);
  const [localPendingJumpKey, setLocalPendingJumpKey] = useState<string>();
  const requestedJumpKey = pendingJumpKey ?? localPendingJumpKey;
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) => (rows[index]?.kind === 'tool-stream' ? 132 : 96),
    overscan: 8,
    getScrollElement: () => scrollElementRef?.current ?? null,
    getItemKey: (index) => rows[index]?.key ?? `transcript-row-${index}`,
    measureElement: (element) => element.getBoundingClientRect().height,
  });
  useLayoutEffect(() => {
    if (!tailScrollRequest || rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    const frame = window.requestAnimationFrame(() => {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rows.length, tailScrollRequest, virtualizer]);
  useLayoutEffect(() => {
    void open;
    void rows.length;
    const rowKey = affectedRowKeyRef.current;
    affectedRowKeyRef.current = undefined;
    if (!rowKey) return;
    const row = Array.from(
      virtualizerRef.current?.querySelectorAll<HTMLElement>('[data-index]') ??
        [],
    ).find((element) => element.dataset.transcriptRow === rowKey);
    if (!row) return;
    virtualizer.measureElement(row);
    const frame = window.requestAnimationFrame(() => {
      const settledRow = Array.from(
        virtualizerRef.current?.querySelectorAll<HTMLElement>('[data-index]') ??
          [],
      ).find((element) => element.dataset.transcriptRow === rowKey);
      if (settledRow) virtualizer.measureElement(settledRow);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, rows.length, virtualizer]);
  const loadedLandmarks = useMemo(
    () => buildTranscriptLandmarks(items),
    [items],
  );
  const landmarks = useMemo<TranscriptLandmark[]>(
    () => mergeTranscriptLandmarks(loadedLandmarks, outline),
    [loadedLandmarks, outline],
  );
  const rowIndexByKey = useMemo(() => {
    const result = new Map<string, number>();
    rows.forEach((row, index) => {
      result.set(row.key, index);
      if (row.kind === 'tool-stream') {
        for (let itemIndex = row.start; itemIndex <= row.end; itemIndex += 1) {
          const item = items[itemIndex];
          if (item) result.set(item.key, index);
        }
      }
    });
    return result;
  }, [items, rows]);
  useLayoutEffect(() => {
    if (!requestedJumpKey) return;
    const rowIndex =
      rowIndexByKey.get(requestedJumpKey) ??
      rowIndexByKey.get(`group-${requestedJumpKey}`);
    if (rowIndex === undefined) return;
    if (pendingJumpKey !== undefined) onPendingJumpHandled?.();
    else setLocalPendingJumpKey(undefined);
    virtualizer.scrollToIndex(rowIndex, { align: 'start' });
    const frame = window.requestAnimationFrame(() => {
      virtualizer.scrollToIndex(rowIndex, { align: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    onPendingJumpHandled,
    pendingJumpKey,
    requestedJumpKey,
    rowIndexByKey,
    virtualizer,
  ]);
  const jumpToLandmark = async (landmark: TranscriptLandmark) => {
    onBeforeScroll?.();
    const loadedRowIndex =
      rowIndexByKey.get(landmark.key) ??
      rowIndexByKey.get(`group-${landmark.key}`);
    if (loadedRowIndex !== undefined) {
      virtualizer.scrollToIndex(loadedRowIndex, { align: 'start' });
      return;
    }
    const target = outline?.find(
      (candidate) =>
        candidate.id === landmark.key ||
        `group-${candidate.id}` === landmark.key,
    );
    if (!target || !onJumpToLandmark || !(await onJumpToLandmark(target)))
      return;
    // The async loader updates rows in a later render. Store the stable key so
    // that render's row map, rather than this handler's stale closure, owns the
    // actual virtualizer jump.
    setLocalPendingJumpKey(landmark.key);
  };
  const captureScrollAnchor =
    useVirtualTranscriptScrollRestoration(scrollElementRef);

  const renderToolStream = (start: number, end: number, streamKey: string) => (
    <TranscriptToolStream
      items={items.slice(start, end + 1)}
      cwd={runtime?.cwd}
      expanded={open.has(streamKey)}
      timestampOverride={
        start > 0 ? transcriptItemTimestamp(items[start - 1]) : undefined
      }
      captureScrollAnchor={captureScrollAnchor}
      onToggle={(nextExpanded) => {
        affectedRowKeyRef.current = streamKey;
        setOpen((current) => {
          const next = new Set(current);
          nextExpanded ? next.add(streamKey) : next.delete(streamKey);
          return next;
        });
      }}
    />
  );

  return (
    <div className="transcript transcript-virtualized">
      <TranscriptOutline
        landmarks={landmarks}
        open={outlineOpen}
        onOpenChange={onOutlineOpenChange}
        onJump={jumpToLandmark}
        scrollElementRef={scrollElementRef}
      />
      <div
        ref={virtualizerRef}
        className="transcript-virtualizer"
        style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              data-transcript-row={row.key}
              ref={virtualizer.measureElement}
              className="transcript-virtual-row"
              style={{
                position: 'absolute',
                top: virtualRow.start,
                left: 0,
                width: '100%',
              }}
            >
              {row.kind === 'tool-stream' ? (
                renderToolStream(row.start, row.end, row.key)
              ) : (
                <div data-transcript-key={items[row.index]?.key}>
                  <TranscriptEntry item={items[row.index]} cwd={runtime?.cwd} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <LiveCompactionEvent runtime={runtime} />
      <LivePauseEvent runtime={runtime} />
    </div>
  );
}
