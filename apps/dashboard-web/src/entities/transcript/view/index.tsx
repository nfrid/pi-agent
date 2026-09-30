import type { TranscriptProjection } from '@pi-dashboard/domain';
import type {
  RuntimeSnapshot,
  SessionBranchPoint,
  SessionBranchTopology,
  SessionOutlineLandmark,
} from '@pi-dashboard/protocol';
import {
  type ComponentProps,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FileLinkContext } from '../../../features/file-viewer/link-context';
import { useTranscriptPreviewPreference } from '../../../shared/lib/transcript-display';
import {
  annotateCodemodeCalls,
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
import type { TranscriptScrollCommand } from '../scroll-command';
import { TranscriptToolStream } from '../tool-stream';
import {
  restoreRenderedAnchor,
  useTranscriptScrollCommand,
} from '../use-scroll-command';
import {
  buildTranscriptToolStreams,
  buildVirtualTranscriptRows,
  shouldPreserveWorkLogOnAppend,
} from '../virtual-rows';
import { TranscriptWorkLog } from '../work-log';
import { LiveCompactionEvent, LivePauseEvent } from './live-events';
import { VirtualizedTranscript } from './virtualized';

export function Transcript({
  cwd,
  ...props
}: ComponentProps<typeof TranscriptContent> & { cwd?: string }) {
  const base = useMemo(
    () => ({ cwd: cwd ?? props.runtime?.cwd }),
    [cwd, props.runtime?.cwd],
  );
  return (
    <FileLinkContext.Provider value={base}>
      <TranscriptContent {...props} />
    </FileLinkContext.Provider>
  );
}

function TranscriptContent({
  entries,
  projection,
  modelItems,
  runtime,
  outline,
  branchTopology,
  onJumpToLandmark,
  onBeforeScroll,
  scrollElementRef,
  leadingContinuation,
  prependAnchor,
  onPrependAnchorRestored,
  scrollCommand,
  scrollPhase = 'following',
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
  scrollCommand?: TranscriptScrollCommand;
  scrollPhase?: 'restoring' | 'following' | 'reading';
}) {
  const transcriptScrollElementRef = scrollElementRef;
  const input = projection ?? entries ?? [];
  const items = useMemo(
    () =>
      annotateCodemodeCalls(
        modelItems ?? toTranscriptEntries(input, { leadingContinuation }),
      ),
    [input, leadingContinuation, modelItems],
  );
  const transcriptPreview = useTranscriptPreviewPreference();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [openToolDetails, setOpenToolDetails] = useState<Set<string>>(
    new Set(),
  );
  const previousClosuresRef = useRef<Set<string> | undefined>(undefined);
  const closures = useMemo(
    () =>
      items.flatMap((item) =>
        item.workLogClosure ? [item.workLogClosure] : [],
      ),
    [items],
  );
  const currentClosureIds = useMemo(
    () => new Set(closures.map((closure) => closure.finalMessageId)),
    [closures],
  );
  const previousClosureIds = previousClosuresRef.current;
  const newClosures = useMemo(
    () =>
      previousClosureIds
        ? closures.filter(
            (closure) => !previousClosureIds.has(closure.finalMessageId),
          )
        : [],
    [closures, previousClosureIds],
  );
  const streams = useMemo(() => buildTranscriptToolStreams(items), [items]);
  const preserveNewClosures =
    newClosures.length > 0 &&
    newClosures.some((closure) =>
      shouldPreserveWorkLogOnAppend(
        closure,
        items,
        streams,
        open,
        openToolDetails,
        scrollPhase,
      ),
    );
  const openForPlan = useMemo(() => {
    const next = new Set(open);
    if (preserveNewClosures)
      for (const closure of newClosures)
        next.add(`work-log-${closure.finalMessageId}`);
    return next;
  }, [newClosures, open, preserveNewClosures]);
  const rows = useMemo(
    () => buildVirtualTranscriptRows(items, openForPlan),
    [items, openForPlan],
  );
  useEffect(() => {
    previousClosuresRef.current = currentClosureIds;
    if (!preserveNewClosures) return;
    setOpen((current) => {
      const next = new Set(current);
      for (const closure of newClosures)
        next.add(`work-log-${closure.finalMessageId}`);
      return next;
    });
  }, [currentClosureIds, newClosures, preserveNewClosures]);
  const [pendingJumpKey, setPendingJumpKey] = useState<string>();
  const isVirtualizedTranscript =
    items.length > 80 && virtualize && Boolean(transcriptScrollElementRef);
  const restoredRevisionRef = useRef(0);
  const placeScrollCommand = useCallback(
    (command: TranscriptScrollCommand) => {
      const element = transcriptScrollElementRef?.current;
      if (!element) return false;
      if (command.kind === 'latest') {
        element.scrollTop = element.scrollHeight;
        return true;
      }
      const settled = restoreRenderedAnchor(element, command);
      if (settled !== undefined) return settled;
      element.scrollTop = command.scrollTop;
      return true;
    },
    [transcriptScrollElementRef],
  );
  useTranscriptScrollCommand(
    isVirtualizedTranscript ? undefined : scrollCommand,
    placeScrollCommand,
  );
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
  };
  useLayoutEffect(() => {
    // Re-run after a pending ordinal load commits its rendered items.
    void loadedLandmarks;
    if (!pendingJumpKey) return;
    const containingWorkLog = rows.find(
      (row) =>
        row.kind === 'work-log' &&
        !row.expanded &&
        items
          .slice(row.start, row.end + 1)
          .some((item) => item.key === pendingJumpKey),
    );
    if (containingWorkLog?.kind === 'work-log') {
      setOpen((current) => new Set(current).add(containingWorkLog.key));
      return;
    }
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
  }, [
    items,
    loadedLandmarks,
    pendingJumpKey,
    rows,
    transcriptScrollElementRef,
  ]);
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
        open={openForPlan}
        setOpen={setOpen}
        openToolDetails={openToolDetails}
        setOpenToolDetails={setOpenToolDetails}
        runtime={runtime}
        onBeforeScroll={onBeforeScroll}
        pendingJumpKey={pendingJumpKey}
        onPendingJumpHandled={() => setPendingJumpKey(undefined)}
        scrollCommand={scrollCommand}
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
        onBranchPointChange={setBranchPointId}
        onJump={jumpToLandmark}
        scrollElementRef={transcriptScrollElementRef}
      />
      {rows.map((row) => {
        if (row.kind === 'work-log')
          return (
            <TranscriptWorkLog
              key={row.key}
              rowKey={row.key}
              durationMs={row.durationMs}
              actionCount={row.actionCount}
              expanded={row.expanded}
              onToggle={() => {
                setOpen((current) => {
                  const next = new Set(current);
                  row.expanded ? next.delete(row.key) : next.add(row.key);
                  return next;
                });
              }}
            />
          );
        if (row.kind === 'tool-stream')
          return (
            <TranscriptToolStream
              key={row.key}
              items={items.slice(row.start, row.end + 1)}
              cwd={runtime?.cwd}
              expanded={open.has(row.key)}
              timestampOverride={
                row.start > 0
                  ? transcriptItemTimestamp(items[row.start - 1])
                  : undefined
              }
              openToolDetails={openToolDetails}
              onToolDetailToggle={(key, expanded) =>
                setOpenToolDetails((current) => {
                  const next = new Set(current);
                  expanded ? next.add(key) : next.delete(key);
                  return next;
                })
              }
              previewStartCount={transcriptPreview.start}
              previewEndCount={transcriptPreview.end}
              onToggle={(nextExpanded) => {
                setOpen((current) => {
                  const next = new Set(current);
                  nextExpanded ? next.add(row.key) : next.delete(row.key);
                  return next;
                });
              }}
            />
          );
        const item = items[row.index];
        if (!item) return null;
        return (
          <div data-transcript-key={item.key} key={row.key}>
            <TranscriptEntry
              item={item}
              cwd={runtime?.cwd}
              branchPoint={
                item.role === 'user'
                  ? branchPointsByMessageId.get(item.key)
                  : undefined
              }
              onOpenBranchPaths={openBranchPaths}
              toolDetailExpanded={
                item.tool ? openToolDetails.has(item.key) : undefined
              }
              onToolDetailToggle={
                item.tool
                  ? (expanded) =>
                      setOpenToolDetails((current) => {
                        const next = new Set(current);
                        expanded ? next.add(item.key) : next.delete(item.key);
                        return next;
                      })
                  : undefined
              }
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
