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
  useCallback,
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
  currentTranscriptUserTurnKey,
  mergeTranscriptLandmarks,
  type TranscriptLandmark,
  transcriptItemTimestamp,
} from '../landmarks';
import { TranscriptOutline } from '../outline';
import type { TranscriptScrollCommand } from '../scroll-command';
import { TranscriptToolStream } from '../tool-stream';
import {
  restoreRenderedAnchor,
  useTranscriptScrollCommand,
} from '../use-scroll-command';
import { buildVirtualTranscriptRows } from '../virtual-rows';
import {
  isNearPageBottom,
  useVirtualTranscriptScrollRestoration,
} from '../virtual-scroll';
import { TranscriptWorkLog } from '../work-log';
import { LiveCompactionEvent, LivePauseEvent } from './live-events';

export function VirtualizedTranscript({
  items,
  open,
  setOpen,
  openToolDetails,
  setOpenToolDetails,
  runtime,
  outline,
  branchTopology,
  branchPointId,
  onOpenBranchPaths,
  onBranchPointChange,
  onJumpToLandmark,
  onBeforeScroll,
  pendingJumpKey,
  onPendingJumpHandled,
  scrollCommand,
  scrollElementRef,
  previewStartCount,
  previewEndCount,
}: {
  items: readonly TranscriptModelItem[];
  open: ReadonlySet<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
  openToolDetails: ReadonlySet<string>;
  setOpenToolDetails: Dispatch<SetStateAction<Set<string>>>;
  runtime?: RuntimeSnapshot;
  outline?: readonly SessionOutlineLandmark[];
  branchTopology?: SessionBranchTopology;
  branchPointId?: string;
  onOpenBranchPaths?: (point: SessionBranchPoint) => void;
  onBranchPointChange?: (pointId: string | undefined) => void;
  onJumpToLandmark?: (
    landmark: SessionOutlineLandmark,
  ) => Promise<boolean> | boolean;
  onBeforeScroll?: () => void;
  /** A jump requested before a regular-to-virtualized renderer transition. */
  pendingJumpKey?: string;
  onPendingJumpHandled?: () => void;
  scrollCommand?: TranscriptScrollCommand;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  previewStartCount: number;
  previewEndCount: number;
}) {
  const rows = useMemo(
    () => buildVirtualTranscriptRows(items, open),
    [items, open],
  );
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
  const measureTranscriptElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        virtualizer.measureElement(null);
        return;
      }
      const scrollElement = scrollElementRef.current;
      const viewportTop = scrollElement?.getBoundingClientRect().top;
      const anchor =
        scrollElement && viewportTop !== undefined
          ? isNearPageBottom(
              scrollElement.scrollHeight,
              scrollElement.scrollTop,
              scrollElement.clientHeight,
            )
            ? undefined
            : Array.from(
                scrollElement.querySelectorAll<HTMLElement>(
                  '[data-transcript-row]',
                ),
              )
                .map((candidate) => ({
                  element: candidate,
                  top: candidate.getBoundingClientRect().top - viewportTop,
                }))
                .find(({ element: candidate }) => {
                  const rect = candidate.getBoundingClientRect();
                  return (
                    rect.bottom > viewportTop &&
                    rect.top < viewportTop + scrollElement.clientHeight
                  );
                })
          : undefined;
      virtualizer.measureElement(element);
      if (anchor && scrollElement) {
        const nextTop =
          anchor.element.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top;
        scrollElement.scrollTop += nextTop - anchor.top;
      }
    },
    [scrollElementRef, virtualizer],
  );
  // During restoration our measured anchor, not estimated-row compensation,
  // owns the offset. Otherwise asynchronous size adjustments race the command
  // against the virtualizer's last observed (pre-command) scroll position.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    scrollCommand?.kind === 'anchor' && !scrollCommand.signal.aborted
      ? () => false
      : undefined;
  useLayoutEffect(() => {
    void open;
    void rows.length;
    const rowKey = affectedRowKeyRef.current;
    affectedRowKeyRef.current = undefined;
    if (!rowKey) return;
    const row = Array.from(
      virtualizerRef.current?.querySelectorAll<HTMLDivElement>(
        '[data-index]',
      ) ?? [],
    ).find((element) => element.dataset.transcriptRow === rowKey);
    if (!row) return;
    measureTranscriptElement(row);
    const frame = window.requestAnimationFrame(() => {
      const settledRow = Array.from(
        virtualizerRef.current?.querySelectorAll<HTMLDivElement>(
          '[data-index]',
        ) ?? [],
      ).find((element) => element.dataset.transcriptRow === rowKey);
      if (settledRow) measureTranscriptElement(settledRow);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [measureTranscriptElement, open, rows.length]);
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
      if (row.kind === 'tool-stream' || row.kind === 'work-log') {
        for (let itemIndex = row.start; itemIndex <= row.end; itemIndex += 1) {
          const item = items[itemIndex];
          if (item) result.set(item.key, index);
        }
      }
    });
    return result;
  }, [items, rows]);
  // scrollToIndex/scrollToOffset start TanStack's private reconciliation loop.
  // Read its measurement instead: only our cancellable controller may schedule
  // writes, otherwise that loop can undo restoration or later manual input.
  const scrollToRow = useCallback(
    (index: number, align: 'start' | 'end') => {
      const offset = virtualizer.getOffsetForIndex(index, align)?.[0];
      const element = scrollElementRef.current;
      if (element && offset !== undefined) element.scrollTop = offset;
    },
    [scrollElementRef, virtualizer],
  );
  const placeScrollCommand = useCallback(
    (command: TranscriptScrollCommand) => {
      const element = scrollElementRef.current;
      if (!element || rows.length === 0) return false;
      if (command.kind === 'latest') {
        scrollToRow(rows.length - 1, 'end');
        return true;
      }
      const settled = restoreRenderedAnchor(element, command);
      if (settled !== undefined) return settled;
      const index = command.rowKey
        ? rowIndexByKey.get(command.rowKey)
        : undefined;
      if (index === undefined) {
        element.scrollTop = command.scrollTop;
        return true;
      }
      scrollToRow(index, 'start');
      return false;
    },
    [rowIndexByKey, rows.length, scrollElementRef, scrollToRow],
  );
  useTranscriptScrollCommand(scrollCommand, placeScrollCommand);
  useLayoutEffect(() => {
    if (!requestedJumpKey) return;
    const rowIndex =
      rowIndexByKey.get(requestedJumpKey) ??
      rowIndexByKey.get(`group-${requestedJumpKey}`);
    if (rowIndex === undefined) return;
    const row = rows[rowIndex];
    if (row?.kind === 'work-log' && !row.expanded) {
      setOpen((current) => new Set(current).add(row.key));
      return;
    }
    scrollToRow(rowIndex, 'start');
    const frame = window.requestAnimationFrame(() => {
      const element = scrollElementRef.current;
      const target = Array.from(
        element?.querySelectorAll<HTMLElement>('[data-transcript-key]') ?? [],
      ).find(
        (candidate) =>
          candidate.dataset.transcriptKey === requestedJumpKey ||
          candidate.dataset.transcriptKey === `group-${requestedJumpKey}`,
      );
      // Newly unfolded rows initially have estimated heights. Align the mounted
      // target before clearing the request; clearing earlier cancels this frame.
      if (element && target)
        element.scrollTop +=
          target.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
      else scrollToRow(rowIndex, 'start');
      if (pendingJumpKey !== undefined) onPendingJumpHandled?.();
      else setLocalPendingJumpKey(undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    onPendingJumpHandled,
    pendingJumpKey,
    requestedJumpKey,
    rowIndexByKey,
    rows,
    scrollElementRef,
    scrollToRow,
    setOpen,
  ]);
  const jumpToLandmark = async (landmark: TranscriptLandmark) => {
    onBeforeScroll?.();
    const loadedRowIndex =
      rowIndexByKey.get(landmark.key) ??
      rowIndexByKey.get(`group-${landmark.key}`);
    if (loadedRowIndex !== undefined) {
      const row = rows[loadedRowIndex];
      if (row?.kind === 'work-log' && !row.expanded) {
        setOpen((current) => new Set(current).add(row.key));
        setLocalPendingJumpKey(landmark.key);
        return;
      }
      scrollToRow(loadedRowIndex, 'start');
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
  const virtualItems = virtualizer.getVirtualItems();
  const viewportMidpoint =
    (scrollElementRef.current?.scrollTop ?? 0) +
    (scrollElementRef.current?.clientHeight ?? 0) / 2;
  const viewportRow = [...virtualItems]
    .reverse()
    .find((virtualItem) => virtualItem.start <= viewportMidpoint);
  const viewportRowData =
    viewportRow === undefined ? undefined : rows[viewportRow.index];
  const currentItemIndex =
    viewportRowData?.kind === 'tool-stream' ||
    viewportRowData?.kind === 'work-log'
      ? viewportRowData.start
      : viewportRowData?.kind === 'entry'
        ? viewportRowData.index
        : undefined;
  const currentItemKey =
    currentItemIndex === undefined ? undefined : items[currentItemIndex]?.key;
  const currentUserTurnKey = currentTranscriptUserTurnKey(
    landmarks,
    loadedLandmarks,
    currentItemKey,
    currentItemIndex,
  );

  const renderToolStream = (start: number, end: number, streamKey: string) => (
    <TranscriptToolStream
      items={items.slice(start, end + 1)}
      cwd={runtime?.cwd}
      expanded={open.has(streamKey)}
      timestampOverride={
        start > 0 ? transcriptItemTimestamp(items[start - 1]) : undefined
      }
      captureScrollAnchor={captureScrollAnchor}
      openToolDetails={openToolDetails}
      onToolDetailToggle={(key, expanded) =>
        setOpenToolDetails((current) => {
          const next = new Set(current);
          expanded ? next.add(key) : next.delete(key);
          return next;
        })
      }
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
        onBranchPointChange={onBranchPointChange}
        onJump={jumpToLandmark}
        scrollElementRef={scrollElementRef}
        currentUserTurnKey={currentUserTurnKey}
      />
      <div
        ref={virtualizerRef}
        className="transcript-virtualizer"
        style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
      >
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              data-transcript-row={row.key}
              ref={measureTranscriptElement}
              className="transcript-virtual-row"
              style={{
                position: 'absolute',
                top: virtualRow.start,
              }}
            >
              {row.kind === 'tool-stream' ? (
                renderToolStream(row.start, row.end, row.key)
              ) : row.kind === 'work-log' ? (
                <TranscriptWorkLog
                  rowKey={row.key}
                  durationMs={row.durationMs}
                  actionCount={row.actionCount}
                  expanded={row.expanded}
                  onToggle={() => {
                    captureScrollAnchor(row.key);
                    affectedRowKeyRef.current = row.key;
                    setOpen((current) => {
                      const next = new Set(current);
                      row.expanded ? next.delete(row.key) : next.add(row.key);
                      return next;
                    });
                  }}
                />
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
                    toolDetailExpanded={
                      items[row.index]?.tool
                        ? openToolDetails.has(items[row.index]?.key ?? '')
                        : undefined
                    }
                    onToolDetailToggle={
                      items[row.index]?.tool
                        ? (expanded) =>
                            setOpenToolDetails((current) => {
                              const next = new Set(current);
                              const key = items[row.index]?.key;
                              if (key)
                                expanded ? next.add(key) : next.delete(key);
                              return next;
                            })
                        : undefined
                    }
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
