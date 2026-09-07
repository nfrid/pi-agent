import type {
  RuntimeSnapshot,
  SessionBranchPoint,
  SessionBranchTopology,
  SessionOutlineLandmark,
} from '@pi-dashboard/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TranscriptModelItem } from '../../../transcript';
import { indexBranchPointsByMessageId } from '../branching';
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
  branchTopology,
  branchPointId,
  onOpenBranchPaths,
  onBranchPointChange,
  onJumpToLandmark,
  tailScrollRequest,
  tailScrollRequestSessionId,
  outlineOpen,
  onOutlineOpenChange,
  onBeforeScroll,
  pendingJumpKey,
  onPendingJumpHandled,
  scrollRestore,
  onScrollRestoreComplete,
  scrollElementRef,
  previewStartCount,
  previewEndCount,
}: {
  items: readonly TranscriptModelItem[];
  open: ReadonlySet<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
  runtime?: RuntimeSnapshot;
  outline?: readonly SessionOutlineLandmark[];
  branchTopology?: SessionBranchTopology;
  branchPointId?: string;
  onOpenBranchPaths?: (point: SessionBranchPoint) => void;
  onBranchPointChange?: (pointId: string | undefined) => void;
  onJumpToLandmark?: (
    landmark: SessionOutlineLandmark,
  ) => Promise<boolean> | boolean;
  tailScrollRequest?: number;
  tailScrollRequestSessionId?: string;
  outlineOpen?: boolean;
  onOutlineOpenChange?: (open: boolean) => void;
  onBeforeScroll?: () => void;
  /** A jump requested before a regular-to-virtualized renderer transition. */
  pendingJumpKey?: string;
  onPendingJumpHandled?: () => void;
  scrollRestore?: {
    mode: 'following' | 'manual';
    rowKey?: string;
    rowOffset?: number;
    scrollTop: number;
  };
  onScrollRestoreComplete?: () => void;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  previewStartCount: number;
  previewEndCount: number;
}) {
  const rows = useMemo(() => buildVirtualTranscriptRows(items), [items]);
  const virtualizerRef = useRef<HTMLDivElement>(null);
  const affectedRowKeyRef = useRef<string | undefined>(undefined);
  const consumedTailRequestRef = useRef<string | undefined>(undefined);
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
    const requestKey = `${tailScrollRequestSessionId ?? ''}:${tailScrollRequest}`;
    if (consumedTailRequestRef.current === requestKey) return;
    consumedTailRequestRef.current = requestKey;
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    const frame = window.requestAnimationFrame(() => {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rows.length, tailScrollRequest, tailScrollRequestSessionId, virtualizer]);
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
  useLayoutEffect(() => {
    void previewStartCount;
    void previewEndCount;
    virtualizer.measure();
  }, [previewEndCount, previewStartCount, virtualizer]);
  const loadedLandmarks = useMemo(
    () => buildTranscriptLandmarks(items),
    [items],
  );
  const landmarks = useMemo<TranscriptLandmark[]>(
    () => mergeTranscriptLandmarks(loadedLandmarks, outline),
    [loadedLandmarks, outline],
  );
  const branchPointsByMessageId = useMemo(
    () => indexBranchPointsByMessageId(branchTopology),
    [branchTopology],
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
  const scrollRestoreRef = useRef<typeof scrollRestore>(undefined);
  const restoreFramesRef = useRef<{
    request: NonNullable<typeof scrollRestore>;
    first?: number;
    second?: number;
  }>(undefined);
  useEffect(() => {
    const previous = restoreFramesRef.current;
    if (!scrollRestore) {
      if (previous?.first !== undefined)
        window.cancelAnimationFrame(previous.first);
      if (previous?.second !== undefined)
        window.cancelAnimationFrame(previous.second);
      restoreFramesRef.current = undefined;
      return;
    }
    if (scrollRestoreRef.current === scrollRestore) return;
    if (previous) {
      if (previous.first !== undefined)
        window.cancelAnimationFrame(previous.first);
      if (previous.second !== undefined)
        window.cancelAnimationFrame(previous.second);
    }
    const attempt: {
      request: NonNullable<typeof scrollRestore>;
      first?: number;
      second?: number;
    } = { request: scrollRestore };
    restoreFramesRef.current = attempt;
    const element = scrollElementRef.current;
    const finish = () => {
      if (restoreFramesRef.current !== attempt) return;
      restoreFramesRef.current = undefined;
      scrollRestoreRef.current = scrollRestore;
      onScrollRestoreComplete?.();
    };
    if (!element) return finish();
    if (scrollRestore.mode === 'following') return finish();
    const rowIndex = scrollRestore.rowKey
      ? rowIndexByKey.get(scrollRestore.rowKey)
      : undefined;
    if (rowIndex === undefined) {
      element.scrollTop = scrollRestore.scrollTop;
      return finish();
    }
    virtualizer.scrollToIndex(rowIndex, { align: 'start' });
    attempt.first = window.requestAnimationFrame(() => {
      if (restoreFramesRef.current !== attempt) return;
      virtualizer.measure();
      virtualizer.scrollToIndex(rowIndex, { align: 'start' });
      attempt.second = window.requestAnimationFrame(() => {
        if (restoreFramesRef.current !== attempt) return;
        const row = Array.from(
          virtualizerRef.current?.querySelectorAll<HTMLElement>(
            '[data-index]',
          ) ?? [],
        ).find(
          (candidate) =>
            candidate.dataset.transcriptRow === scrollRestore.rowKey,
        );
        if (row && scrollRestore.rowOffset !== undefined) {
          element.scrollTop +=
            row.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            scrollRestore.rowOffset;
        } else element.scrollTop = scrollRestore.scrollTop;
        finish();
      });
    });
    return () => {
      if (restoreFramesRef.current !== attempt) return;
      if (attempt.first !== undefined)
        window.cancelAnimationFrame(attempt.first);
      if (attempt.second !== undefined)
        window.cancelAnimationFrame(attempt.second);
      restoreFramesRef.current = undefined;
    };
  }, [
    onScrollRestoreComplete,
    rowIndexByKey,
    scrollElementRef,
    scrollRestore,
    virtualizer,
  ]);
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
      previewStartCount={previewStartCount}
      previewEndCount={previewEndCount}
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
        branchTopology={branchTopology}
        branchPointId={branchPointId}
        onOpenBranchPaths={onOpenBranchPaths}
        onBranchPointChange={onBranchPointChange}
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
                  <TranscriptEntry
                    item={items[row.index]}
                    cwd={runtime?.cwd}
                    branchPoint={
                      items[row.index]?.role === 'user'
                        ? branchPointsByMessageId.get(
                            items[row.index]?.key ?? '',
                          )
                        : undefined
                    }
                    onOpenBranchPaths={onOpenBranchPaths}
                  />
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
