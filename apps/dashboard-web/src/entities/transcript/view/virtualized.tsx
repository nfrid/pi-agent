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
} from 'react';
import type { TranscriptModelItem } from '../../../transcript';
import type { TranscriptGroup } from '../activity';
import { invokeActivityExpansion } from '../activity-expansion';
import { TranscriptActivityGroup } from '../activity-group';
import { TranscriptEntry } from '../entries';
import {
  buildTranscriptLandmarks,
  type TranscriptLandmark,
} from '../landmarks';
import { TranscriptOutline } from '../outline';
import { buildVirtualTranscriptRows } from '../virtual-rows';
import { useVirtualTranscriptScrollRestoration } from '../virtual-scroll';
import { LiveCompactionEvent, LivePauseEvent } from './live-events';

export function VirtualizedTranscript({
  items,
  groups,
  open,
  setOpen,
  runtime,
  outline,
  onJumpToLandmark,
  tailScrollRequest,
  outlineOpen,
  onOutlineOpenChange,
  onBeforeScroll,
  scrollElementRef,
}: {
  items: readonly TranscriptModelItem[];
  groups: readonly TranscriptGroup[];
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
  scrollElementRef: RefObject<HTMLDivElement | null>;
}) {
  const rows = useMemo(
    () => buildVirtualTranscriptRows(items, groups),
    [groups, items],
  );
  const virtualizerRef = useRef<HTMLDivElement>(null);
  const affectedRowKeyRef = useRef<string | undefined>(undefined);
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? 132 : 96),
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
    () => buildTranscriptLandmarks(items, groups),
    [groups, items],
  );
  const landmarks = useMemo<TranscriptLandmark[]>(() => {
    if (outline === undefined) return loadedLandmarks;
    return outline.map((landmark) => {
      const loaded = loadedLandmarks.find(
        (candidate) =>
          candidate.key === landmark.id ||
          candidate.key === `group-${landmark.id}`,
      );
      return loaded
        ? { ...loaded, label: landmark.label }
        : {
            key: landmark.id,
            label: landmark.label,
            kind: landmark.kind,
            itemIndex: landmark.ordinal,
            ...(landmark.timestamp === undefined
              ? {}
              : { timestamp: landmark.timestamp }),
          };
    });
  }, [loadedLandmarks, outline]);
  const rowIndexByKey = useMemo(() => {
    const result = new Map<string, number>();
    rows.forEach((row, index) => {
      result.set(row.key, index);
      if (row.kind === 'group') {
        result.set(row.key.replace(/^group-/, ''), index);
        for (
          let itemIndex = row.group.start;
          itemIndex <= row.group.end;
          itemIndex += 1
        ) {
          const item = items[itemIndex];
          if (item) result.set(item.key, index);
        }
      }
    });
    return result;
  }, [items, rows]);
  const jumpToLandmark = async (landmark: TranscriptLandmark) => {
    onBeforeScroll?.();
    const target = outline?.find(
      (candidate) =>
        candidate.id === landmark.key ||
        `group-${candidate.id}` === landmark.key,
    );
    if (target && onJumpToLandmark) {
      if (!(await onJumpToLandmark(target))) return;
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    }
    const rowIndex =
      rowIndexByKey.get(landmark.key) ??
      rowIndexByKey.get(`group-${landmark.key}`);
    if (rowIndex !== undefined)
      virtualizer.scrollToIndex(rowIndex, { align: 'start' });
  };
  const captureScrollAnchor =
    useVirtualTranscriptScrollRestoration(scrollElementRef);

  const renderGroup = (group: TranscriptGroup) => {
    const groupKey = items[group.start]?.key ?? `group-${group.start}`;
    const groupItems = items.slice(group.start, group.end + 1);
    return (
      <TranscriptActivityGroup
        group={group}
        groupKey={groupKey}
        items={groupItems}
        runtime={runtime}
        expanded={open.has(groupKey)}
        captureScrollAnchor={captureScrollAnchor}
        onToggle={(nextExpanded) => {
          affectedRowKeyRef.current = `group-${groupKey}`;
          setOpen((current) => {
            const next = new Set(current);
            nextExpanded ? next.add(groupKey) : next.delete(groupKey);
            return next;
          });
          invokeActivityExpansion(runtime, nextExpanded);
        }}
      />
    );
  };

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
              {row.kind === 'group' ? (
                renderGroup(row.group)
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
