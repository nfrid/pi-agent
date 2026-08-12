import { projectActivityGroups } from '@pi-dashboard/activity-model';
import {
  commandMutationOptions,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import type { TranscriptProjection } from '@pi-dashboard/domain';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  type Dispatch,
  type SetStateAction,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
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
}: {
  /** Legacy raw-entry input retained for embedders. */
  entries?: unknown[];
  /** Preferred canonical domain projection input. */
  projection?: TranscriptProjection;
  runtime?: RuntimeSnapshot;
  tailScrollRequest?: number;
  outlineOpen?: boolean;
  onOutlineOpenChange?: (open: boolean) => void;
}) {
  const input = projection ?? entries ?? [];
  const items = useMemo(() => toTranscriptEntries(input), [input]);
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
  const landmarks = useMemo(
    () => buildTranscriptLandmarks(items, groups),
    [groups, items],
  );
  const jumpToLandmark = (landmark: TranscriptLandmark) => {
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('[data-transcript-key]'),
    ).find((element) => element.dataset.transcriptKey === landmark.key);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const { groupByStart, groupCoverage } = useMemo(
    () => buildTranscriptGroupCoverage(items.length, groups),
    [groups, items.length],
  );
  if (items.length > 80)
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
      />
    );
  return (
    <div className="transcript">
      <TranscriptOutline
        landmarks={landmarks}
        open={outlineOpen}
        onOpenChange={onOutlineOpenChange}
        onJump={jumpToLandmark}
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
  if (pause?.phase !== 'paused') return null;
  return (
    <div
      className="session-event event-pause live-pause-event"
      role="status"
      aria-live="polite"
    >
      <span className="session-event-icon" aria-hidden="true">
        <PauseIcon className="pause-icon" />
      </span>
      <strong>{pause.label}</strong>
      <small>at a safe boundary</small>
      <AriaButton
        type="button"
        className="pause-continue-button"
        aria-label="Continue paused runtime"
        isDisabled
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
}: {
  items: readonly TranscriptModelItem[];
  groups: readonly TranscriptGroup[];
  open: ReadonlySet<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
  runtime?: RuntimeSnapshot;
  tailScrollRequest?: number;
  outlineOpen?: boolean;
  onOutlineOpenChange?: (open: boolean) => void;
}) {
  const rows = useMemo(
    () => buildVirtualTranscriptRows(items, groups),
    [groups, items],
  );
  const virtualizerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? 132 : 96),
    overscan: 8,
    scrollMargin,
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
    void rows.length;
    const measure = () => {
      const element = virtualizerRef.current;
      if (!element) return;
      const next = element.getBoundingClientRect().top + window.scrollY;
      setScrollMargin((current) =>
        Math.abs(current - next) < 1 ? current : next,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [rows.length]);
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
  const jumpToLandmark = (landmark: TranscriptLandmark) => {
    const rowIndex = rowIndexByKey.get(landmark.key);
    if (rowIndex !== undefined)
      virtualizer.scrollToIndex(rowIndex, { align: 'start' });
  };
  const captureScrollAnchor = useVirtualTranscriptScrollRestoration();

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
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start - scrollMargin}px)`,
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
