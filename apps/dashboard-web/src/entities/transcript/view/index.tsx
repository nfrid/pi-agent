import { projectActivityGroups } from '@pi-dashboard/activity-model';
import type { TranscriptProjection } from '@pi-dashboard/domain';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import {
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toTranscriptEntries } from '../../../transcript';
import { invokeActivityExpansion } from '../activity-expansion';
import { TranscriptActivityGroup } from '../activity-group';
import { TranscriptEntry } from '../entries';
import {
  buildTranscriptLandmarks,
  type TranscriptLandmark,
} from '../landmarks';
import { TranscriptOutline } from '../outline';
import { buildTranscriptGroupCoverage } from '../virtual-rows';
import { LiveCompactionEvent, LivePauseEvent } from './live-events';
import { VirtualizedTranscript } from './virtualized';

export function Transcript({
  entries,
  projection,
  runtime,
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
  runtime?: RuntimeSnapshot;
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
    revision: number;
  };
  onPrependAnchorRestored?: (revision: number) => void;
}) {
  const transcriptScrollElementRef = scrollElementRef;
  const input = projection ?? entries ?? [];
  const items = useMemo(
    () => toTranscriptEntries(input, { leadingContinuation }),
    [input, leadingContinuation],
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
    const addedHeight = Math.max(
      0,
      element.scrollHeight - prependAnchor.scrollHeight,
    );
    element.scrollTop = prependAnchor.scrollTop + addedHeight;
    restoredRevisionRef.current = prependAnchor.revision;
    onPrependAnchorRestored?.(prependAnchor.revision);
  }, [onPrependAnchorRestored, prependAnchor, transcriptScrollElementRef]);
  const landmarks = useMemo(
    () => buildTranscriptLandmarks(items, groups),
    [groups, items],
  );
  const jumpToLandmark = (landmark: TranscriptLandmark) => {
    onBeforeScroll?.();
    const scrollElement = transcriptScrollElementRef?.current;
    const target = scrollElement
      ? Array.from(
          scrollElement.querySelectorAll<HTMLElement>('[data-transcript-key]'),
        ).find((element) => element.dataset.transcriptKey === landmark.key)
      : document.querySelector<HTMLElement>(
          `[data-transcript-key="${CSS.escape(landmark.key)}"]`,
        );
    if (!target) return;
    if (!scrollElement) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    scrollElement.scrollTo({
      top:
        scrollElement.scrollTop +
        target.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top,
      behavior: 'smooth',
    });
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
        open={open}
        setOpen={setOpen}
        runtime={runtime}
        tailScrollRequest={tailScrollRequest}
        outlineOpen={outlineOpen}
        onOutlineOpenChange={onOutlineOpenChange}
        onBeforeScroll={onBeforeScroll}
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
