import type { RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SurfaceDrawer, SurfaceStats } from '../../features/surface-drawer';
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
): string {
  if (kind === 'user')
    return deliveryMode === 'steer' ? 'Steering message' : 'User message';
  if (kind === 'assistant') return 'Agent update';
  return 'Agent activity';
}

function landmarkTime(
  timestamp: number | string | undefined,
): string | undefined {
  return formatDashboardTimestamp(timestamp, 'sidebar');
}

export function TranscriptOutline({
  landmarks,
  open = false,
  onOpenChange,
  onJump,
  scrollElementRef,
}: {
  landmarks: readonly TranscriptLandmark[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
        outlineLandmarks.map((landmark) => (
          <button
            type="button"
            className={`surface-row transcript-outline-item outline-${landmark.kind}${landmark.deliveryMode === 'steer' ? ' outline-steering' : ''}`}
            key={landmark.key}
            onClick={() => {
              onJump(landmark);
              onOpenChange?.(false);
            }}
            aria-label={landmark.label}
          >
            <DashboardTime
              className="transcript-outline-time"
              timestamp={landmark.timestamp}
            />
            <i aria-hidden="true" />
            <span>{landmark.label}</span>
          </button>
        ))
      ) : (
        <p className="muted">No transcript landmarks yet.</p>
      )}
    </div>
  );
  return (
    <>
      <aside className="transcript-minimap" aria-label="Transcript outline">
        <span className="transcript-minimap-label">Outline</span>
        {minimapLandmarks.map((landmark) => (
          <button
            type="button"
            className={`transcript-minimap-marker outline-${landmark.kind}${landmark.deliveryMode === 'steer' ? ' outline-steering' : ''}${activeKey === landmark.key ? ' active' : ''}`}
            key={landmark.key}
            aria-label={landmark.label}
            data-preview={landmark.label}
            onClick={() => onJump(landmark)}
          >
            <span
              className="transcript-minimap-preview"
              data-label={landmark.label}
              data-meta={`${landmarkType(landmark.kind, landmark.deliveryMode)}${landmarkTime(landmark.timestamp) ? ` · ${landmarkTime(landmark.timestamp)}` : ''}`}
              aria-hidden="true"
            />
            <i aria-hidden="true" />
          </button>
        ))}
      </aside>
      <SurfaceDrawer
        isOpen={open}
        title="Transcript outline"
        eyebrow="Transcript outline"
        hideTitle
        headerSummary="Navigate transcript landmarks"
        headerContent={
          <SurfaceStats
            className="work-header-stats"
            showZero
            stats={[{ label: 'landmarks', value: outlineLandmarks.length }]}
          />
        }
        className="surface-drawer work-surface-drawer outline-sheet"
        onClose={() => onOpenChange?.(false)}
      >
        <div className="work-surface-content">{list}</div>
      </SurfaceDrawer>
    </>
  );
}
