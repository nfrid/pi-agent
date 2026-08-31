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
  sampleTranscriptLandmarks,
  sampleTranscriptMinimapLandmarks,
  type TranscriptLandmark,
} from './landmarks';

function landmarkType(
  kind: TranscriptLandmark['kind'],
  deliveryMode?: TranscriptLandmark['deliveryMode'],
  typeLabel?: string,
): string {
  if (typeLabel) return typeLabel;
  if (kind === 'user')
    return deliveryMode === 'steer' ? 'Steering message' : 'User message';
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
  open = false,
  onOpenChange,
  onOpenBranchPaths,
  onBranchPointChange,
  onJump,
  scrollElementRef,
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
}) {
  const outlineLandmarks = useMemo(
    () => sampleTranscriptLandmarks(landmarks, 256),
    [landmarks],
  );
  const minimapLandmarks = useMemo(
    () => sampleTranscriptMinimapLandmarks(landmarks, 48),
    [landmarks],
  );
  const [activeKey, setActiveKey] = useState(minimapLandmarks[0]?.key);
  const branchPointsById = useMemo(
    () =>
      new Map((branchTopology?.points ?? []).map((point) => [point.id, point])),
    [branchTopology],
  );
  const selectedBranchPoint = branchPointId
    ? branchPointsById.get(branchPointId)
    : undefined;
  const outlineLandmarksRef = useRef(outlineLandmarks);
  const minimapLandmarksRef = useRef(minimapLandmarks);
  outlineLandmarksRef.current = outlineLandmarks;
  minimapLandmarksRef.current = minimapLandmarks;
  const landmarkRevision = useMemo(
    () =>
      `${outlineLandmarks.map((landmark) => `${landmark.key}:${landmark.itemIndex}`).join('|')}::${minimapLandmarks.map((landmark) => landmark.key).join('|')}`,
    [minimapLandmarks, outlineLandmarks],
  );
  useEffect(() => {
    void landmarkRevision;
    const currentMinimap = minimapLandmarksRef.current;
    setActiveKey((current) =>
      currentMinimap.some((landmark) => landmark.key === current)
        ? current
        : currentMinimap[0]?.key,
    );
    let frame: number | undefined;
    const updateActive = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        const currentOutline = outlineLandmarksRef.current;
        const currentMinimap = minimapLandmarksRef.current;
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
        for (const landmark of currentOutline) {
          const element = elements.get(landmark.key);
          if (
            element &&
            element.getBoundingClientRect().top <= viewportTop + 12
          )
            active = landmark;
        }
        if (active) {
          const marker = currentMinimap
            .filter((landmark) => landmark.itemIndex <= active.itemIndex)
            .at(-1);
          setActiveKey(marker?.key ?? currentMinimap[0]?.key);
        }
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
  }, [landmarkRevision, scrollElementRef]);
  const list = (
    <div className="transcript-outline-list surface-scroll-region">
      {outlineLandmarks.length ? (
        outlineLandmarks.map((landmark) => {
          const branchPoint = branchPointsById.get(landmark.key);
          const hasBranches = Boolean(
            branchPoint && branchPoint.paths.length > 1,
          );
          return (
            <div
              className={`surface-row transcript-outline-item outline-${landmark.kind}${landmark.deliveryMode === 'steer' ? ' outline-steering' : ''}${landmark.variant ? ` outline-${landmark.variant}` : ''}`}
              key={landmark.key}
            >
              <button
                type="button"
                className="transcript-outline-jump"
                onClick={() => {
                  onJump(landmark);
                  onOpenChange?.(false);
                }}
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
        <p className="muted">No transcript landmarks yet.</p>
      )}
    </div>
  );
  const pages = [
    {
      id: 'transcript-outline',
      title: 'Transcript outline',
      eyebrow: 'Transcript outline',
      hideTitle: true,
      headerSummary: 'Navigate transcript landmarks',
      headerContent: (
        <SurfaceStats
          className="work-header-stats"
          showZero
          stats={[{ label: 'landmarks', value: outlineLandmarks.length }]}
        />
      ),
      children: <div className="work-surface-content">{list}</div>,
    },
    ...(selectedBranchPoint
      ? [
          {
            id: `transcript-branch-${selectedBranchPoint.id}`,
            title: 'Immediate paths',
            eyebrow: 'Read-only branch paths',
            headerSummary: 'Paths from this user message',
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
                    {path.laterTurnCount !== undefined ? (
                      <small>
                        {path.laterTurnCount} later turn
                        {path.laterTurnCount === 1 ? '' : 's'}
                      </small>
                    ) : null}
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
      <aside className="transcript-minimap" aria-label="Transcript outline">
        <span className="transcript-minimap-label">Outline</span>
        {minimapLandmarks.map((landmark) => (
          <button
            type="button"
            className={`transcript-minimap-marker outline-${landmark.kind}${landmark.deliveryMode === 'steer' ? ' outline-steering' : ''}${landmark.variant ? ` outline-${landmark.variant}` : ''}${activeKey === landmark.key ? ' active' : ''}`}
            key={landmark.key}
            aria-label={landmark.label}
            data-preview={landmark.label}
            onClick={() => onJump(landmark)}
          >
            <span
              className="transcript-minimap-preview"
              data-label={landmark.label}
              data-meta={`${landmarkType(landmark.kind, landmark.deliveryMode, landmark.typeLabel)}${landmarkTime(landmark.timestamp) ? ` · ${landmarkTime(landmark.timestamp)}` : ''}`}
              aria-hidden="true"
            />
            <i aria-hidden="true" />
          </button>
        ))}
      </aside>
      <SurfaceStack
        isOpen={open}
        kind="work"
        pages={pages}
        className="surface-drawer work-surface-drawer outline-sheet"
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
