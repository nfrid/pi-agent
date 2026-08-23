import type { DashboardLiveStore } from '@pi-dashboard/client';
import { useEffect, useRef, useState } from 'react';
import { useDashboardNavigate } from '../../routes/navigation';
import { delegateHistoryInvocationToStatus } from '../delegate/history-compose';
import { surfaceText } from '../delegate/surface-state';
import { SurfaceDrawer } from '../surface-drawer';
import { DelegateInspectorTranscript } from './canonical-transcript';
import {
  type DelegateInspectorDetailState,
  DelegateInspectorDetails,
  DelegateInspectorMetadata,
  type DelegateInspectorRunOption,
  delegateDetailHasError,
  delegateTranscriptSessionId,
  selectedDelegateRunId,
} from './detail-panel';

export function DelegateTranscriptInspector({
  row,
  now,
  runOptions,
  detail,
  onRunSelected,
  store,
  isOpen,
  paused = false,
  onClose,
}: {
  row: import('../delegate/history-compose').DelegateInspectionStatus;
  now: number;
  runOptions?: readonly DelegateInspectorRunOption[];
  detail?: DelegateInspectorDetailState;
  onRunSelected?: (run: DelegateInspectorRunOption) => void;
  store?: DashboardLiveStore;
  isOpen: boolean;
  paused?: boolean;
  onClose: () => void;
}) {
  const go = useDashboardNavigate();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const lineageRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const lineageChanged = lineageRef.current !== row.lineageId;
    lineageRef.current = row.lineageId;
    const nextId = selectedDelegateRunId(
      selectedRunId,
      runOptions,
      lineageChanged,
    );
    if (nextId !== selectedRunId) setSelectedRunId(nextId);
  }, [row.lineageId, runOptions, selectedRunId]);
  const selectedRun = runOptions?.find((run) => run.id === selectedRunId);
  const inspectedRow = selectedRun?.row ?? row;
  const selectedDetail =
    detail?.run &&
    detail.run.runId === inspectedRow.runId &&
    detail.run.lineageId === inspectedRow.lineageId
      ? delegateHistoryInvocationToStatus(detail.run.run)
      : undefined;
  const displayedRow = selectedDetail ?? inspectedRow;
  const transcriptSessionId = delegateTranscriptSessionId(
    row,
    runOptions,
    detail,
  );
  const transcriptRow = transcriptSessionId
    ? { ...displayedRow, sessionId: transcriptSessionId }
    : displayedRow;
  return (
    <SurfaceDrawer
      title="Delegate transcript"
      eyebrow="Delegate"
      headerSummary={surfaceText(displayedRow.name, 'Subagent')}
      headerContent={<DelegateInspectorMetadata row={displayedRow} now={now} />}
      className="surface-drawer delegate-transcript-drawer"
      isOpen={isOpen}
      paused={paused}
      onClose={onClose}
    >
      <div className="delegate-transcript-inspector-body">
        {runOptions && runOptions.length > 1 && (
          <fieldset
            className="delegate-inspector-run-picker"
            aria-label="Select delegate run"
          >
            <legend>Runs in this continuation</legend>
            {runOptions.map((run) => (
              <button
                type="button"
                key={run.id}
                aria-pressed={run.id === inspectedRow.runId}
                onClick={() => {
                  setSelectedRunId(run.id);
                  onRunSelected?.(run);
                }}
              >
                {run.label}
              </button>
            ))}
          </fieldset>
        )}
        {detail?.loading && !transcriptSessionId && (
          <p className="delegate-transcript-loading" role="status">
            Loading persisted delegate transcript…
          </p>
        )}
        {delegateDetailHasError(detail) && !transcriptSessionId && (
          <p className="delegate-transcript-error" role="alert">
            Unable to load this persisted delegate transcript.
          </p>
        )}
        {transcriptSessionId && (
          <section
            className="delegate-transcript-source"
            aria-label="Transcript source"
          >
            <span>
              <strong>Child session transcript</strong>
              <small>Stored in a child session</small>
            </span>
            <button
              type="button"
              className="delegate-open-session"
              onClick={() =>
                go(`/sessions/${encodeURIComponent(transcriptSessionId)}`)
              }
            >
              Open full session
            </button>
          </section>
        )}
        <DelegateInspectorDetails row={displayedRow} now={now} />
        <DelegateInspectorTranscript
          row={transcriptRow}
          store={store}
          isOpen={isOpen}
        />
      </div>
    </SurfaceDrawer>
  );
}

export { DelegateTranscript, delegateTranscriptItems } from './adaptation';
export { DelegateInspectorTranscript } from './canonical-transcript';
export {
  type DelegateInspectorDetailState,
  DelegateInspectorDetails,
  DelegateInspectorMetadata,
  type DelegateInspectorRunOption,
  delegateDetailHasError,
  delegateTranscriptSessionId,
  selectedDelegateRunId,
} from './detail-panel';
