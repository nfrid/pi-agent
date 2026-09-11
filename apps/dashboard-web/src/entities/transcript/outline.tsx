import type { SessionBranchTopology } from '@pi-dashboard/protocol';
import type { RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SurfaceStack, SurfaceStats } from '../../features/surface-stack';
import {
  DashboardTime,
  formatDashboardTimestamp,
} from '../../features/timestamp';
import { indexBranchPointsById } from './branching';
import {
  clusterTranscriptUserTurns,
  selectTranscriptUserTurns,
  type TranscriptLandmark,
} from './landmarks';

const MAX_RAIL_HEIGHT = 320;
const RAIL_MARKER_HEIGHT = 8;

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
  onBranchPointChange,
  onJump,
  scrollElementRef,
  currentUserTurnKey,
}: {
  landmarks: readonly TranscriptLandmark[];
  branchTopology?: SessionBranchTopology;
  branchPointId?: string;
  onBranchPointChange?: (pointId: string | undefined) => void;
  onJump: (landmark: TranscriptLandmark) => void;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  /** The user turn represented by the first visible model item. */
  currentUserTurnKey?: string;
}) {
  const userTurns = useMemo(
    () => selectTranscriptUserTurns(landmarks),
    [landmarks],
  );
  const [railViewportHeight, setRailViewportHeight] = useState(MAX_RAIL_HEIGHT);
  const [railTop, setRailTop] = useState<number>();
  const railClusterCapacity = Math.max(
    1,
    Math.floor(Math.max(20, railViewportHeight) / RAIL_MARKER_HEIGHT),
  );
  const railClusters = useMemo(
    () => clusterTranscriptUserTurns(userTurns, railClusterCapacity),
    [railClusterCapacity, userTurns],
  );
  const railHeight = Math.min(
    MAX_RAIL_HEIGHT,
    Math.max(RAIL_MARKER_HEIGHT, railClusters.length * RAIL_MARKER_HEIGHT),
  );
  const [activeKey, setActiveKey] = useState(userTurns[0]?.key);
  const devicePixelRatio =
    typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const tickHeight = pixelSnappedTickHeight(devicePixelRatio);
  const railActualTop =
    railTop === undefined ? undefined : railTop - railHeight / 2;
  const branchPointsById = useMemo(
    () => indexBranchPointsById(branchTopology),
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

  const branchPages = selectedBranchPoint
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
    : [];

  return (
    <>
      <aside
        className="transcript-minimap"
        aria-label="Transcript turn map"
        style={{ height: railHeight, top: railTop }}
      >
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
        isOpen={Boolean(selectedBranchPoint)}
        kind="work"
        pages={branchPages}
        className="surface-drawer work-surface-drawer outline-sheet"
        layerClassName={`surface-drawer-layer outline-sheet-layer${scrollElementRef?.current?.closest('.session-page:not(.session-page-embedded)') ? '' : ' outline-sheet-embedded'}`}
        onDepthChange={() => onBranchPointChange?.(undefined)}
        onClose={() => onBranchPointChange?.(undefined)}
      />
    </>
  );
}
