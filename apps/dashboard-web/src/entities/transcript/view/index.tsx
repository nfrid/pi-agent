import type { TranscriptProjection } from '@pi-dashboard/domain';
import type {
  RuntimeSnapshot,
  SessionBranchPoint,
  SessionBranchTopology,
  SessionOutlineLandmark,
} from '@pi-dashboard/protocol';
import {
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranscriptPreviewPreference } from '../../../shared/lib/transcript-display';
import {
  type TranscriptModelItem,
  toTranscriptEntries,
} from '../../../transcript';
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
import { buildTranscriptToolStreams } from '../virtual-rows';
import { LiveCompactionEvent, LivePauseEvent } from './live-events';
import { VirtualizedTranscript } from './virtualized';

export function Transcript({
  entries,
  projection,
  modelItems,
  runtime,
  outline,
  branchTopology,
  onJumpToLandmark,
  tailScrollRequest,
  outlineOpen,
  onOutlineOpenChange,
  onBeforeScroll,
  scrollElementRef,
  leadingContinuation,
  prependAnchor,
  onPrependAnchorRestored,
  virtualize = false,
}: {
  /** Legacy raw-entry input retained for embedders. */
  entries?: unknown[];
  /** Preferred canonical domain projection input. */
  projection?: TranscriptProjection;
  /** Prepared items for feature-owned transcript message presentations. */
  modelItems?: readonly TranscriptModelItem[];
  runtime?: RuntimeSnapshot;
  outline?: readonly SessionOutlineLandmark[];
  branchTopology?: SessionBranchTopology;
  onJumpToLandmark?: (
    landmark: SessionOutlineLandmark,
  ) => Promise<boolean> | boolean;
  tailScrollRequest?: number;
  outlineOpen?: boolean;
  onOutlineOpenChange?: (open: boolean) => void;
  onBeforeScroll?: () => void;
  /** Session routes opt into virtualization only with an attached scrollport. */
  virtualize?: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  leadingContinuation?: boolean;
  prependAnchor?: {
    scrollTop: number;
    scrollHeight: number;
    rowKey?: string;
    rowTop?: number;
    revision: number;
  };
  onPrependAnchorRestored?: (revision: number) => void;
}) {
  const transcriptScrollElementRef = scrollElementRef;
  const input = projection ?? entries ?? [];
  const items = useMemo(
    () =>
      modelItems
        ? [...modelItems]
        : toTranscriptEntries(input, { leadingContinuation }),
    [input, leadingContinuation, modelItems],
  );
  const toolStreams = useMemo(() => buildTranscriptToolStreams(items), [items]);
  const transcriptPreview = useTranscriptPreviewPreference();
  const streamByStart = useMemo(
    () => new Map(toolStreams.map((stream) => [stream.start, stream])),
    [toolStreams],
  );
  const streamCoverage = useMemo(() => {
    const coverage = new Uint8Array(items.length);
    for (const stream of toolStreams)
      for (let index = stream.start + 1; index <= stream.end; index += 1)
        coverage[index] = 1;
    return coverage;
  }, [items.length, toolStreams]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pendingJumpKey, setPendingJumpKey] = useState<string>();
  const isVirtualizedTranscript =
    items.length > 80 && virtualize && Boolean(transcriptScrollElementRef);
  const restoredRevisionRef = useRef(0);
  useLayoutEffect(() => {
    const element = transcriptScrollElementRef?.current;
    if (
      !element ||
      !prependAnchor ||
      restoredRevisionRef.current === prependAnchor.revision
    )
      return;
    const anchoredRow = prependAnchor.rowKey
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            '[data-transcript-key], [data-transcript-row]',
          ),
        ).find(
          (candidate) =>
            (candidate.dataset.transcriptKey ??
              candidate.dataset.transcriptRow) === prependAnchor.rowKey,
        )
      : undefined;
    if (anchoredRow && prependAnchor.rowTop !== undefined) {
      const nextTop =
        anchoredRow.getBoundingClientRect().top -
        element.getBoundingClientRect().top;
      element.scrollTop += nextTop - prependAnchor.rowTop;
    } else {
      const addedHeight = Math.max(
        0,
        element.scrollHeight - prependAnchor.scrollHeight,
      );
      element.scrollTop = prependAnchor.scrollTop + addedHeight;
    }
    restoredRevisionRef.current = prependAnchor.revision;
    onPrependAnchorRestored?.(prependAnchor.revision);
  }, [onPrependAnchorRestored, prependAnchor, transcriptScrollElementRef]);
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
  const [branchPointId, setBranchPointId] = useState<string>();
  const openBranchPaths = (point: SessionBranchPoint) => {
    setBranchPointId(point.id);
    onOutlineOpenChange?.(true);
  };
  const handleOutlineOpenChange = (open: boolean) => {
    if (!open) setBranchPointId(undefined);
    onOutlineOpenChange?.(open);
  };
  useLayoutEffect(() => {
    // Re-run after a pending ordinal load commits its rendered items.
    void loadedLandmarks;
    if (!pendingJumpKey) return;
    const scrollElement = transcriptScrollElementRef?.current;
    const keys = new Set([pendingJumpKey, `group-${pendingJumpKey}`]);
    const target = Array.from(
      (scrollElement ?? document).querySelectorAll<HTMLElement>(
        '[data-transcript-key]',
      ),
    ).find((element) => keys.has(element.dataset.transcriptKey ?? ''));
    // The target may be absent in this render while an ordinal load is being
    // committed. Keep the key pending and let the loaded render retry it.
    if (!target) return;
    setPendingJumpKey(undefined);
    if (!scrollElement) {
      target.scrollIntoView({ behavior: 'auto', block: 'start' });
      return;
    }
    scrollElement.scrollTo({
      top:
        scrollElement.scrollTop +
        target.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top,
      behavior: 'auto',
    });
  }, [loadedLandmarks, pendingJumpKey, transcriptScrollElementRef]);
  const jumpToLandmark = async (landmark: TranscriptLandmark) => {
    onBeforeScroll?.();
    if (onJumpToLandmark) {
      const target = outline?.find(
        (candidate) =>
          candidate.id === landmark.key ||
          `group-${candidate.id}` === landmark.key,
      );
      if (target && !(await onJumpToLandmark(target))) return;
    }
    setPendingJumpKey(landmark.key);
  };
  if (isVirtualizedTranscript && transcriptScrollElementRef)
    return (
      <VirtualizedTranscript
        items={items}
        outline={outline}
        branchTopology={branchTopology}
        branchPointId={branchPointId}
        onOpenBranchPaths={openBranchPaths}
        onBranchPointChange={setBranchPointId}
        onJumpToLandmark={onJumpToLandmark}
        open={open}
        setOpen={setOpen}
        runtime={runtime}
        tailScrollRequest={tailScrollRequest}
        outlineOpen={outlineOpen}
        onOutlineOpenChange={handleOutlineOpenChange}
        onBeforeScroll={onBeforeScroll}
        pendingJumpKey={pendingJumpKey}
        onPendingJumpHandled={() => setPendingJumpKey(undefined)}
        scrollElementRef={transcriptScrollElementRef}
        previewStartCount={transcriptPreview.start}
        previewEndCount={transcriptPreview.end}
      />
    );
  return (
    <div className="transcript">
      <TranscriptOutline
        landmarks={landmarks}
        branchTopology={branchTopology}
        branchPointId={branchPointId}
        onOpenBranchPaths={openBranchPaths}
        onBranchPointChange={setBranchPointId}
        open={outlineOpen}
        onOpenChange={handleOutlineOpenChange}
        onJump={jumpToLandmark}
        scrollElementRef={transcriptScrollElementRef}
      />
      {items.map((item, index) => {
        const stream = streamByStart.get(index);
        if (stream) {
          const streamKey = stream.key;
          return (
            <TranscriptToolStream
              key={streamKey}
              items={items.slice(stream.start, stream.end + 1)}
              cwd={runtime?.cwd}
              expanded={open.has(streamKey)}
              timestampOverride={
                stream.start > 0
                  ? transcriptItemTimestamp(items[stream.start - 1])
                  : undefined
              }
              previewStartCount={transcriptPreview.start}
              previewEndCount={transcriptPreview.end}
              onToggle={(nextExpanded) => {
                setOpen((current) => {
                  const next = new Set(current);
                  nextExpanded ? next.add(streamKey) : next.delete(streamKey);
                  return next;
                });
              }}
            />
          );
        }
        if (streamCoverage[index]) return null;
        return (
          <div data-transcript-key={item.key} key={item.key}>
            <TranscriptEntry
              item={item}
              cwd={runtime?.cwd}
              branchPoint={
                item.role === 'user'
                  ? branchPointsByMessageId.get(item.key)
                  : undefined
              }
              onOpenBranchPaths={openBranchPaths}
            />
          </div>
        );
      })}
      <LiveCompactionEvent runtime={runtime} />
      <LivePauseEvent runtime={runtime} />
    </div>
  );
}

export { LivePauseEvent } from './live-events';
