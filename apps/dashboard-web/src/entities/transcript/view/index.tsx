import { projectActivityGroups } from '@pi-dashboard/activity-model';
import type { TranscriptProjection } from '@pi-dashboard/domain';
import type {
  RuntimeSnapshot,
  SessionOutlineLandmark,
} from '@pi-dashboard/protocol';
import {
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type TranscriptModelItem,
  toTranscriptEntries,
} from '../../../transcript';
import { invokeActivityExpansion } from '../activity-expansion';
import { TranscriptActivityGroup } from '../activity-group';
import { TranscriptEntry } from '../entries';
import {
  buildTranscriptLandmarks,
  mergeTranscriptLandmarks,
  type TranscriptLandmark,
} from '../landmarks';
import { TranscriptOutline } from '../outline';
import { buildTranscriptGroupCoverage } from '../virtual-rows';
import { LiveCompactionEvent, LivePauseEvent } from './live-events';
import { VirtualizedTranscript } from './virtualized';

export function Transcript({
  entries,
  projection,
  modelItems,
  runtime,
  outline,
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
  const modelEntries = useMemo(() => items.map((item) => item.entry), [items]);
  const groups = useMemo(
    () =>
      projectActivityGroups(modelEntries, {
        // Historical groups stay complete; only the transcript tail inherits
        // activity from the runtime when a live tool status is not available.
        liveTail:
          runtime?.online !== false &&
          (runtime?.liveState === 'working' ||
            runtime?.liveState === 'compacting' ||
            runtime?.liveState === 'waiting' ||
            runtime?.liveState === 'aborting' ||
            runtime?.liveState === 'stopping'),
      }),
    [modelEntries, runtime],
  );
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
    () => buildTranscriptLandmarks(items, groups),
    [groups, items],
  );
  const landmarks = useMemo<TranscriptLandmark[]>(
    () => mergeTranscriptLandmarks(loadedLandmarks, outline),
    [loadedLandmarks, outline],
  );
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
  const { groupByStart, groupCoverage } = useMemo(
    () => buildTranscriptGroupCoverage(items.length, groups),
    [groups, items.length],
  );
  if (isVirtualizedTranscript && transcriptScrollElementRef)
    return (
      <VirtualizedTranscript
        items={items}
        groups={groups}
        outline={outline}
        onJumpToLandmark={onJumpToLandmark}
        open={open}
        setOpen={setOpen}
        runtime={runtime}
        tailScrollRequest={tailScrollRequest}
        outlineOpen={outlineOpen}
        onOutlineOpenChange={onOutlineOpenChange}
        onBeforeScroll={onBeforeScroll}
        pendingJumpKey={pendingJumpKey}
        onPendingJumpHandled={() => setPendingJumpKey(undefined)}
        scrollElementRef={transcriptScrollElementRef}
      />
    );
  return (
    <div className="transcript">
      <TranscriptOutline
        landmarks={landmarks}
        open={outlineOpen}
        onOpenChange={onOutlineOpenChange}
        onJump={jumpToLandmark}
        scrollElementRef={transcriptScrollElementRef}
      />
      {items.map((item, index) => {
        const group = groupByStart.get(index);
        if (group) {
          const groupKey = items[group.start]?.key ?? 'unknown-group';
          const groupItems = items.slice(group.start, group.end + 1);
          return (
            <TranscriptActivityGroup
              key={`group-${groupKey}`}
              group={group}
              groupKey={groupKey}
              items={groupItems}
              runtime={runtime}
              expanded={open.has(groupKey)}
              onToggle={(nextExpanded) => {
                setOpen((current) => {
                  const next = new Set(current);
                  nextExpanded ? next.add(groupKey) : next.delete(groupKey);
                  return next;
                });
                invokeActivityExpansion(runtime, nextExpanded);
              }}
            />
          );
        }
        if (groupCoverage[index]) return null;
        return (
          <div data-transcript-key={item.key} key={item.key}>
            <TranscriptEntry item={item} cwd={runtime?.cwd} />
          </div>
        );
      })}
      <LiveCompactionEvent runtime={runtime} />
      <LivePauseEvent runtime={runtime} />
    </div>
  );
}

export { LivePauseEvent } from './live-events';
