import type { DashboardLiveStore } from '@pi-dashboard/client';
import { useRef } from 'react';
import { useDashboardNavigate } from '../../routes/navigation';
import { delegateHistoryInvocationToStatus } from '../delegate/history-compose';
import { DelegateInspectorTranscript } from './canonical-transcript';
import {
  type DelegateInspectorDetailState,
  DelegateInspectorMetadata,
  type DelegateInspectorRunOption,
  delegateDetailHasError,
  delegateTranscriptSessionId,
} from './detail-panel';

export function DelegateInspectorHeaderActions({
  row,
  runOptions,
  detail,
}: {
  row: import('../delegate/history-compose').DelegateInspectionStatus;
  runOptions?: readonly DelegateInspectorRunOption[];
  detail?: DelegateInspectorDetailState;
}) {
  const go = useDashboardNavigate();
  const transcriptSessionId = delegateTranscriptSessionId(
    row,
    runOptions,
    detail,
  );
  if (!transcriptSessionId) return null;
  return (
    <button
      type="button"
      className="session-icon-button delegate-open-session"
      aria-label="Open full delegate session"
      title="Open full delegate session"
      onClick={() => go(`/sessions/${encodeURIComponent(transcriptSessionId)}`)}
    >
      ↗
    </button>
  );
}

export function DelegateTranscriptInspector({
  row,
  now,
  runOptions,
  detail,
  onRunSelected,
  store,
  isOpen,
}: {
  row: import('../delegate/history-compose').DelegateInspectionStatus;
  now: number;
  runOptions?: readonly DelegateInspectorRunOption[];
  detail?: DelegateInspectorDetailState;
  onRunSelected?: (run: DelegateInspectorRunOption) => void;
  store?: DashboardLiveStore;
  isOpen: boolean;
}) {
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const displayedRow = row;
  const currentRun = runOptions?.at(-1);
  const currentDetails =
    detail?.run?.runId === (currentRun?.id ?? row.runId)
      ? detail.run.run.details
      : row.details;
  const transcriptSessionId = delegateTranscriptSessionId(
    row,
    runOptions,
    detail,
  );
  const detailedTranscriptRow =
    detail?.run?.lineageId === row.lineageId
      ? delegateHistoryInvocationToStatus(detail.run.run)
      : displayedRow;
  const transcriptRow = transcriptSessionId
    ? { ...detailedTranscriptRow, sessionId: transcriptSessionId }
    : detailedTranscriptRow;
  return (
    <div
      ref={transcriptScrollRef}
      className="delegate-transcript-inspector-body"
    >
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
      <div className="delegate-inspector-sticky-setup">
        <DelegateInspectorMetadata
          row={displayedRow}
          now={now}
          details={currentDetails}
        />
      </div>
      <DelegateInspectorTranscript
        row={transcriptRow}
        store={store}
        isOpen={isOpen}
        scrollElementRef={transcriptScrollRef}
        runOptions={runOptions}
        detail={detail}
        onRunSelected={onRunSelected}
      />
    </div>
  );
}

export { DelegateTranscript, delegateTranscriptItems } from './adaptation';
export { DelegateInspectorTranscript } from './canonical-transcript';
export {
  type DelegateInspectorDetailState,
  DelegateInspectorMetadata,
  type DelegateInspectorRunOption,
  DelegateParentRequest,
  delegateDetailHasError,
  delegateTranscriptSessionId,
} from './detail-panel';
