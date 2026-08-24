import type { DashboardLiveStore } from '@pi-dashboard/client';
import { useEffect, useRef, useState } from 'react';
import { useDashboardNavigate } from '../../routes/navigation';
import { delegateDisplayName } from '../delegate/display-name';
import { delegateHistoryInvocationToStatus } from '../delegate/history-compose';
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
  inline = false,
  onBack,
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
  inline?: boolean;
  onBack?: () => void;
  onClose: () => void;
}) {
  const go = useDashboardNavigate();
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
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
  const headerContent = (
    <div className="delegate-inspector-header-content">
      <DelegateInspectorMetadata row={displayedRow} now={now} />
      {transcriptSessionId && (
        <button
          type="button"
          className="session-icon-button delegate-open-session"
          aria-label="Open full delegate session"
          title="Open full delegate session"
          onClick={() =>
            go(`/sessions/${encodeURIComponent(transcriptSessionId)}`)
          }
        >
          ↗
        </button>
      )}
    </div>
  );
  const inspectorContent = (
    <div
      ref={transcriptScrollRef}
      className="delegate-transcript-inspector-body"
    >
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
      <DelegateInspectorDetails
        row={displayedRow}
        now={now}
        details={
          selectedDetail && detail?.run?.run.runId === displayedRow.runId
            ? detail.run.run.details
            : displayedRow.details
        }
      />
      <DelegateInspectorTranscript
        row={transcriptRow}
        store={store}
        isOpen={isOpen}
        scrollElementRef={transcriptScrollRef}
      />
    </div>
  );
  if (inline)
    return (
      <div className="delegate-inspector-inline">
        <header className="surface-drawer-header delegate-inspector-inline-header">
          <button
            type="button"
            className="session-icon-button"
            aria-label="Back to delegates"
            title="Back to delegates"
            onClick={onBack}
          >
            ←
          </button>
          <div className="surface-drawer-heading">
            <p className="eyebrow">Delegate</p>
            <h2>{delegateDisplayName(displayedRow)}</h2>
          </div>
          {headerContent}
          <button
            type="button"
            className="session-icon-button"
            aria-label="Close delegate details"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {inspectorContent}
      </div>
    );
  return (
    <SurfaceDrawer
      title={`Delegate · ${delegateDisplayName(displayedRow)}`}
      eyebrow="Delegate"
      headerContent={headerContent}
      className="surface-drawer delegate-transcript-drawer"
      isOpen={isOpen}
      paused={paused}
      onClose={onClose}
    >
      {inspectorContent}
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
