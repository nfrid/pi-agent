import type {
  SessionBranchPoint,
  SessionBranchTopology,
} from '@pi-dashboard/protocol';
import type { RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SurfaceStack, SurfaceStats } from '../../features/surface-stack';
import {
  DashboardTime,
  formatDashboardTimestamp,
} from '../../features/timestamp';
import {
  indexBranchPointsById,
  indexBranchPointsByMessageId,
} from './branching';
import {
  clusterTranscriptUserTurns,
  selectTranscriptUserTurns,
  type TranscriptLandmark,
} from './landmarks';

const MAX_RAIL_HEIGHT = 320;
const RAIL_MARKER_HEIGHT = 8;
const RAIL_OPENER_HEIGHT = 28;

/** Snap the actual top edge of the centered rail, not its transform origin. */
export function pixelSnappedRailTop(
  center: number,
  height: number,
  devicePixelRatio: number,
): number {
  const scale =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return Math.round((center - height / 2) * scale) / scale + height / 2;
}

export function pixelSnappedTickHeight(devicePixelRatio: number): number {
  const scale =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return Math.max(1, Math.round(scale)) / scale;
}

export function pixelSnappedTickOffset(
  position: number,
  devicePixelRatio: number,
): number {
  const scale =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return Math.round(position * scale) / scale - position;
}

function landmarkType(
  kind: TranscriptLandmark['kind'],
  deliveryMode?: TranscriptLandmark['deliveryMode'],
  typeLabel?: string,
): string {
  if (typeLabel) return typeLabel;
  if (kind === 'user')
    return deliveryMode === 'steer' ? 'Steering message' : 'User turn';
  return 'Agent update';
}

function landmarkTime(
  timestamp: number | string | undefined,
): string | undefined {
  return formatDashboardTimestamp(timestamp, 'sidebar');
}

export function TranscriptOutline({
  landmarks,
  branchTopology,
  branchPointId,
  open: controlledOpen,
  onOpenChange: onControlledOpenChange,
  onOpenBranchPaths,
  onBranchPointChange,
  onJump,
  scrollElementRef,
  currentUserTurnKey,
}: {
  landmarks: readonly TranscriptLandmark[];
  branchTopology?: SessionBranchTopology;
  branchPointId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenBranchPaths?: (point: SessionBranchPoint) => void;
  onBranchPointChange?: (pointId: string | undefined) => void;
  onJump: (landmark: TranscriptLandmark) => void;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  /** The user turn represented by the first visible model item. */
  currentUserTurnKey?: string;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const onOpenChange = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(nextOpen);
    onControlledOpenChange?.(nextOpen);
  };
  const userTurns = useMemo(
    () => selectTranscriptUserTurns(landmarks),
    [landmarks],
  );
  const [railViewportHeight, setRailViewportHeight] = useState(MAX_RAIL_HEIGHT);
  const [railTop, setRailTop] = useState<number>();
  const railClusterCapacity = Math.max(
    1,
    Math.floor(
      Math.max(20, railViewportHeight - RAIL_OPENER_HEIGHT) /
        RAIL_MARKER_HEIGHT,
    ),
  );
  const railClusters = useMemo(
    () => clusterTranscriptUserTurns(userTurns, railClusterCapacity),
    [railClusterCapacity, userTurns],
  );
  const railHeight = Math.min(
    MAX_RAIL_HEIGHT,
    Math.max(
      RAIL_OPENER_HEIGHT + RAIL_MARKER_HEIGHT,
      RAIL_OPENER_HEIGHT + railClusters.length * RAIL_MARKER_HEIGHT,
    ),
  );
  const [activeKey, setActiveKey] = useState(userTurns[0]?.key);
  const [search, setSearch] = useState('');
  const devicePixelRatio =
    typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const tickHeight = pixelSnappedTickHeight(devicePixelRatio);
  const railActualTop =
    railTop === undefined ? undefined : railTop - railHeight / 2;
  const searchRef = useRef<HTMLInputElement>(null);
  const branchPointsById = useMemo(
    () => indexBranchPointsById(branchTopology),
    [branchTopology],
  );
  const branchPointsByMessageId = useMemo(
    () => indexBranchPointsByMessageId(branchTopology),
    [branchTopology],
  );
  const selectedBranchPoint = branchPointId
    ? branchPointsById.get(branchPointId)
    : undefined;
  useEffect(() => {
    const scrollElement = scrollElementRef?.current;
    const updateViewportHeight = () => {
      const controlHeight = scrollElement?.classList.contains(
        'session-transcript-scroll',
      )
        ? Number.parseFloat(
            getComputedStyle(scrollElement).getPropertyValue(
              '--session-control-height',
            ),
          ) || 0
        : 0;
      const measuredHeight = scrollElement
        ? scrollElement.clientHeight - controlHeight
        : window.innerHeight - 100;
      setRailViewportHeight(
        Math.min(MAX_RAIL_HEIGHT, Math.max(20, measuredHeight)),
      );
      const center = scrollElement
        ? scrollElement.getBoundingClientRect().top +
          Math.max(0, measuredHeight) / 2
        : window.innerHeight / 2;
      setRailTop(
        pixelSnappedRailTop(center, railHeight, window.devicePixelRatio),
      );
    };
    updateViewportHeight();
    const observer =
      scrollElement && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(updateViewportHeight)
        : undefined;
    if (scrollElement) observer?.observe(scrollElement);
    window.addEventListener('resize', updateViewportHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateViewportHeight);
    };
  }, [railHeight, scrollElementRef]);
  const userTurnsRef = useRef(userTurns);
  userTurnsRef.current = userTurns;
  const landmarkRevision = useMemo(
    () =>
      userTurns
        .map((landmark) => `${landmark.key}:${landmark.itemIndex}`)
        .join('|'),
    [userTurns],
  );

  useEffect(() => {
    void landmarkRevision;
    setActiveKey((current) =>
      userTurnsRef.current.some((landmark) => landmark.key === current)
        ? current
        : userTurnsRef.current[0]?.key,
    );
    let frame: number | undefined;
    const updateActive = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        const currentTurns = userTurnsRef.current;
        if (!currentTurns.length) return;
        if (currentUserTurnKey !== undefined) {
          setActiveKey(currentUserTurnKey);
          return;
        }
        const scrollElement = scrollElementRef?.current;
        const elements = new Map(
          Array.from(
            (scrollElement ?? document).querySelectorAll<HTMLElement>(
              '[data-transcript-key]',
            ),
          ).map((element) => [element.dataset.transcriptKey, element]),
        );
        const viewportTop = scrollElement
          ? scrollElement.getBoundingClientRect().top
          : 0;
        let active: TranscriptLandmark | undefined;
        for (const landmark of currentTurns) {
          const element = elements.get(landmark.key);
          if (
            element &&
            element.getBoundingClientRect().top <= viewportTop + 12
          )
            active = landmark;
        }
        if (active) setActiveKey(active.key);
      });
    };
    const scrollElement = scrollElementRef?.current;
    if (scrollElement)
      scrollElement.addEventListener('scroll', updateActive, {
        passive: true,
      });
    else window.addEventListener('scroll', updateActive, { passive: true });
    updateActive();
    return () => {
      if (scrollElement)
        scrollElement.removeEventListener('scroll', updateActive);
      else window.removeEventListener('scroll', updateActive);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [currentUserTurnKey, landmarkRevision, scrollElementRef]);

  useEffect(() => {
    if (!open || selectedBranchPoint) return;
    const frame = window.requestAnimationFrame(() => {
      searchRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, selectedBranchPoint]);

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredTurns = useMemo(
    () =>
      normalizedSearch
        ? userTurns.filter((landmark) =>
            `${landmark.label} ${landmarkTime(landmark.timestamp) ?? ''}`
              .toLocaleLowerCase()
              .includes(normalizedSearch),
          )
        : userTurns,
    [normalizedSearch, userTurns],
  );
  const jumpAndClose = (landmark: TranscriptLandmark) => {
    onJump(landmark);
    onOpenChange?.(false);
  };
  const focusResult = (current: HTMLElement, direction: 1 | -1) => {
    const results = Array.from(
      current
        .closest('.transcript-outline-list')
        ?.querySelectorAll<HTMLButtonElement>('.transcript-outline-jump') ?? [],
    );
    const index = results.indexOf(current as HTMLButtonElement);
    results[(index + direction + results.length) % results.length]?.focus();
  };
  const list = (
    <div className="transcript-outline-list surface-scroll-region">
      <div className="transcript-outline-search-wrap">
        <input
          ref={searchRef}
          className="transcript-outline-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              event.currentTarget
                .closest('.transcript-outline-list')
                ?.querySelector<HTMLButtonElement>('.transcript-outline-jump')
                ?.focus();
            } else if (event.key === 'Enter' && filteredTurns[0]) {
              event.preventDefault();
              jumpAndClose(filteredTurns[0]);
            }
          }}
          placeholder="Search prompts"
          aria-label="Search transcript turns"
        />
        <span className="transcript-outline-result-count" aria-live="polite">
          {filteredTurns.length} of {userTurns.length} turns
        </span>
      </div>
      {filteredTurns.length ? (
        filteredTurns.map((landmark) => {
          const branchPoint = branchPointsByMessageId.get(landmark.key);
          const hasBranches = Boolean(
            branchPoint && branchPoint.paths.length > 1,
          );
          return (
            <div
              className={`surface-row transcript-outline-item outline-user${landmark.deliveryMode === 'steer' ? ' outline-steering' : ''}${landmark.variant ? ` outline-${landmark.variant}` : ''}`}
              key={landmark.key}
            >
              <button
                type="button"
                className="transcript-outline-jump"
                onClick={() => jumpAndClose(landmark)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    focusResult(
                      event.currentTarget,
                      event.key === 'ArrowDown' ? 1 : -1,
                    );
                  }
                }}
                aria-current={
                  activeKey === landmark.key ? 'location' : undefined
                }
                aria-label={`Jump to ${landmark.label}`}
              >
                <DashboardTime
                  className="transcript-outline-time"
                  timestamp={landmark.timestamp}
                />
                <i aria-hidden="true" />
                <span>{landmark.label}</span>
              </button>
              {hasBranches ? (
                <button
                  type="button"
                  className="transcript-branch-indicator transcript-outline-branch-indicator"
                  aria-haspopup="dialog"
                  aria-label={`Show ${branchPoint?.paths.length} immediate paths from ${landmark.label}`}
                  title={`Show ${branchPoint?.paths.length} immediate paths`}
                  data-branch-count={branchPoint?.paths.length}
                  onClick={() =>
                    onOpenBranchPaths?.(branchPoint as SessionBranchPoint)
                  }
                >
                  <span aria-hidden="true">⑂</span> {branchPoint?.paths.length}
                </button>
              ) : null}
            </div>
          );
        })
      ) : (
        <p className="muted transcript-outline-empty">
          {userTurns.length
            ? 'No matching prompts.'
            : 'No transcript turns yet.'}
        </p>
      )}
    </div>
  );
  const pages = [
    {
      id: 'transcript-outline',
      title: 'Transcript outline',
      eyebrow: null,
      initialFocus: '.transcript-outline-search',
      children: <div className="work-surface-content">{list}</div>,
    },
    ...(selectedBranchPoint
      ? [
          {
            id: `transcript-branch-${selectedBranchPoint.id}`,
            title: 'Immediate paths',
            eyebrow: 'Read-only branch paths',
            headerSummary: 'Sibling choices from this branch point',
            headerContent: (
              <SurfaceStats
                className="work-header-stats"
                showZero
                stats={[
                  { label: 'paths', value: selectedBranchPoint.paths.length },
                ]}
              />
            ),
            children: (
              <div className="work-surface-content transcript-branch-path-list">
                {selectedBranchPoint.paths.map((path) => (
                  <div className="transcript-branch-path" key={path.id}>
                    <div className="transcript-branch-path-heading">
                      <strong>{path.current ? 'Current path' : 'Path'}</strong>
                      {path.lastActivityAt !== undefined ? (
                        <DashboardTime
                          className="transcript-time"
                          timestamp={path.lastActivityAt}
                        />
                      ) : null}
                    </div>
                    <span>{path.label}</span>
                  </div>
                ))}
              </div>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <aside
        className="transcript-minimap"
        aria-label="Transcript turn map"
        style={{ height: railHeight, top: railTop }}
      >
        <button
          type="button"
          className="transcript-minimap-open"
          data-transcript-outline-opener=""
          aria-label="Open transcript outline"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Open transcript outline"
          onClick={() => onOpenChange?.(true)}
        >
          <span aria-hidden="true">⌕</span>
        </button>
        {railClusters.map((cluster) => {
          const representative = cluster.representative;
          const grouped = cluster.landmarks.length > 1;
          const clusterLabel = grouped
            ? `Turns ${cluster.landmarks[0]?.label} through ${cluster.landmarks.at(-1)?.label}; jump to first turn`
            : representative.label;
          return (
            <button
              type="button"
              className={`transcript-minimap-marker${activeKey && cluster.landmarks.some((landmark) => landmark.key === activeKey) ? ' active' : ''}`}
              key={cluster.key}
              aria-label={clusterLabel}
              aria-current={
                activeKey &&
                cluster.landmarks.some((landmark) => landmark.key === activeKey)
                  ? 'location'
                  : undefined
              }
              data-cluster-size={cluster.landmarks.length}
              onClick={() => onJump(representative)}
            >
              <span
                className="transcript-minimap-preview"
                data-label={representative.label}
                data-meta={`${grouped ? `${cluster.landmarks.length} turns · first shown` : landmarkType('user', representative.deliveryMode, representative.typeLabel)}${landmarkTime(representative.timestamp) ? ` · ${landmarkTime(representative.timestamp)}` : ''}`}
                aria-hidden="true"
              />
              <i
                aria-hidden="true"
                style={{
                  height: tickHeight,
                  top:
                    railActualTop === undefined
                      ? '3px'
                      : `calc(3px + ${pixelSnappedTickOffset(
                          railActualTop +
                            RAIL_OPENER_HEIGHT +
                            3 +
                            railClusters.indexOf(cluster) * RAIL_MARKER_HEIGHT,
                          devicePixelRatio,
                        )}px)`,
                }}
              />
            </button>
          );
        })}
      </aside>
      <SurfaceStack
        isOpen={open}
        kind="work"
        pages={pages}
        className="surface-drawer work-surface-drawer outline-sheet"
        layerClassName={`surface-drawer-layer outline-sheet-layer${scrollElementRef?.current?.closest('.session-page:not(.session-page-embedded)') ? '' : ' outline-sheet-embedded'}`}
        onDepthChange={(depth) => {
          if (depth < 2 && selectedBranchPoint) {
            onBranchPointChange?.(undefined);
            return;
          }
          if (depth < 1) onOpenChange?.(false);
        }}
        onClose={() => onOpenChange?.(false)}
      />
    </>
  );
}
