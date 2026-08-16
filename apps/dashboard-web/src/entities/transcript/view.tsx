import { projectActivityGroups } from '@pi-dashboard/activity-model';
import {
  commandMutationOptions,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import type { TranscriptProjection } from '@pi-dashboard/domain';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
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
import { Button as AriaButton } from 'react-aria-components';
import { CONTINUE_ACTION_ID } from '../../../../../extensions/pause/contribution';
import { runtimePauseStatus } from '../../features/extension-surfaces';
import { PauseIcon, PlayIcon } from '../../features/pause-icon';
import {
  type TranscriptModelItem,
  toTranscriptEntries,
} from '../../transcript';
import type { TranscriptGroup } from './activity';
import { invokeActivityExpansion } from './activity-expansion';
import { TranscriptActivityGroup } from './activity-group';
import { TranscriptEntry } from './entries';
import { buildTranscriptLandmarks, type TranscriptLandmark } from './landmarks';
import { TranscriptOutline } from './outline';
import {
  buildTranscriptGroupCoverage,
  buildVirtualTranscriptRows,
} from './virtual-rows';
import { useVirtualTranscriptScrollRestoration } from './virtual-scroll';

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
  prependAnchor?: { key: string; offset: number; revision: number };
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
    if (
      isVirtualizedTranscript ||
      !transcriptScrollElementRef?.current ||
      !prependAnchor ||
      restoredRevisionRef.current === prependAnchor.revision
    )
      return;
    const element = transcriptScrollElementRef.current;
    const target = Array.from(
      element.querySelectorAll<HTMLElement>(
        '[data-transcript-row], [data-transcript-key]',
      ),
    ).find(
      (candidate) =>
        (candidate.dataset.transcriptRow ?? candidate.dataset.transcriptKey) ===
        prependAnchor.key,
    );
    if (!target) return;
    const offset =
      target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.scrollTop += offset - prependAnchor.offset;
    restoredRevisionRef.current = prependAnchor.revision;
  }, [
    isVirtualizedTranscript,
    prependAnchor,
    transcriptScrollElementRef,
  ]);
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
  if (isVirtualizedTranscript)
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
        prependAnchor={prependAnchor}
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

export function LivePauseEvent({ runtime }: { runtime?: RuntimeSnapshot }) {
  const pause = runtimePauseStatus(runtime);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  if (pause?.phase !== 'paused') return null;
  const continueRuntime = async () => {
    if (!runtime || pending || runtime.online === false) return;
    setPending(true);
    setError(undefined);
    try {
      await dashboardHttpClient.invokeAction(
        runtime.runtimeId,
        CONTINUE_ACTION_ID,
        {},
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className={`session-event event-pause live-pause-event${error ? ' event-failed' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="session-event-icon" aria-hidden="true">
        <PauseIcon className="pause-icon" />
      </span>
      <strong>{pause.label}</strong>
      <small>{error ?? (pending ? 'continuing…' : 'at a safe boundary')}</small>
      <AriaButton
        type="button"
        className="pause-continue-button"
        aria-label="Continue paused runtime"
        isDisabled={pending || runtime?.online === false}
        onPress={() => void continueRuntime()}
      >
        <PlayIcon className="play-icon" />
      </AriaButton>
    </div>
  );
}

function LiveCompactionEvent({ runtime }: { runtime?: RuntimeSnapshot }) {
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const [error, setError] = useState<string>();
  if (runtime?.online === false || runtime?.liveState !== 'compacting')
    return null;
  const cancel = async () => {
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: { type: 'compact.cancel' },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div
      className={`session-event event-compaction live-compaction-event${error ? ' event-failed' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="session-event-icon" aria-hidden="true">
        ◇
      </span>
      <strong>Compacting context…</strong>
      <small>{error ?? 'in progress'}</small>
      <AriaButton
        type="button"
        className="compaction-cancel-button"
        aria-label="Cancel context compaction"
        isDisabled={command.isPending}
        onPress={() => void cancel()}
      >
        ■
      </AriaButton>
    </div>
  );
}

function VirtualizedTranscript({
  items,
  groups,
  open,
  setOpen,
  runtime,
  tailScrollRequest,
  outlineOpen,
  onOutlineOpenChange,
  onBeforeScroll,
  scrollElementRef,
  prependAnchor,
}: {
  items: readonly TranscriptModelItem[];
  groups: readonly TranscriptGroup[];
  open: ReadonlySet<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
  runtime?: RuntimeSnapshot;
  tailScrollRequest?: number;
  outlineOpen?: boolean;
  onOutlineOpenChange?: (open: boolean) => void;
  onBeforeScroll?: () => void;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  prependAnchor?: { key: string; offset: number; revision: number };
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
  const landmarks = useMemo(
    () => buildTranscriptLandmarks(items, groups),
    [groups, items],
  );
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
  useLayoutEffect(() => {
    const anchor = prependAnchor;
    const scrollElement = scrollElementRef.current;
    if (!anchor || !scrollElement || rows.length === 0) return;
    const rowIndex = rowIndexByKey.get(anchor.key);
    if (rowIndex === undefined) return;
    // VirtualizedTranscript is the sole prepend restore owner. Resolve the
    // semantic row after the virtualizer has accepted the new row map.
    virtualizer.measure();
    virtualizer.scrollToIndex(rowIndex, { align: 'start' });
    let correctionFrame: number | undefined;
    let attempts = 0;
    const correct = () => {
      correctionFrame = undefined;
      attempts += 1;
      if (attempts > 60) return;
      const row = Array.from(
        virtualizerRef.current?.querySelectorAll<HTMLElement>('[data-index]') ??
          [],
      ).find((element) => element.dataset.transcriptRow === anchor.key);
      if (!row) {
        correctionFrame = window.requestAnimationFrame(correct);
        return;
      }
      virtualizer.measureElement(row);
      const offset =
        row.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top;
      scrollElement.scrollTop += offset - anchor.offset;
    };
    correctionFrame = window.requestAnimationFrame(() => {
      correctionFrame = window.requestAnimationFrame(correct);
    });
    return () => {
      if (correctionFrame !== undefined)
        window.cancelAnimationFrame(correctionFrame);
    };
  }, [
    prependAnchor,
    rowIndexByKey,
    rows.length,
    scrollElementRef,
    virtualizer,
  ]);
  const jumpToLandmark = (landmark: TranscriptLandmark) => {
    onBeforeScroll?.();
    const rowIndex = rowIndexByKey.get(landmark.key);
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
