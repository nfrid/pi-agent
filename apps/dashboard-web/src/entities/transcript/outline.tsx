import { useEffect, useMemo, useRef, useState } from 'react';
import { DashboardDialog, SurfaceStats } from '../../features/dashboard-dialog';
import { DashboardTime } from '../../features/timestamp';
import {
  sampleTranscriptLandmarks,
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
  if (timestamp === undefined) return undefined;
  const numeric =
    typeof timestamp === 'string' && /^\d+$/u.test(timestamp)
      ? Number(timestamp)
      : timestamp;
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function TranscriptOutline({
  landmarks,
  open = false,
  onOpenChange,
  onJump,
}: {
  landmarks: readonly TranscriptLandmark[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onJump: (landmark: TranscriptLandmark) => void;
}) {
  const outlineLandmarks = useMemo(
    () => sampleTranscriptLandmarks(landmarks, 160),
    [landmarks],
  );
  const minimapLandmarks = useMemo(
    () => sampleTranscriptLandmarks(landmarks, 48),
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
        const elements = new Map(
          Array.from(
            document.querySelectorAll<HTMLElement>('[data-transcript-key]'),
          ).map((element) => [element.dataset.transcriptKey, element]),
        );
        let active: TranscriptLandmark | undefined;
        for (const landmark of currentOutline) {
          const element = elements.get(landmark.key);
          if (element && element.getBoundingClientRect().top <= 120)
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
    window.addEventListener('scroll', updateActive, { passive: true });
    updateActive();
    return () => {
      window.removeEventListener('scroll', updateActive);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [landmarkRevision]);
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
          >
            <i aria-hidden="true" />
            <span>{landmark.label}</span>
            <DashboardTime
              className="transcript-outline-time"
              timestamp={landmark.timestamp}
            />
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
      <DashboardDialog
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
        className="surface-dialog work-surface-dialog outline-sheet"
        onClose={() => onOpenChange?.(false)}
      >
        <div className="work-surface-content">{list}</div>
      </DashboardDialog>
    </>
  );
}
