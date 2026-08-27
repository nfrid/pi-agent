import type { DashboardLiveStore } from '@pi-dashboard/client';
import { useRef } from 'react';
import { useDashboardNavigate } from '../../routes/navigation';
import { delegateDisplayName } from '../delegate/display-name';
import { delegateHistoryInvocationToStatus } from '../delegate/history-compose';
import { SurfaceDrawer } from '../surface-drawer';
import { DelegateInspectorTranscript } from './canonical-transcript';
import {
  type DelegateInspectorDetailState,
  DelegateInspectorMetadata,
  type DelegateInspectorRunOption,
  delegateDetailHasError,
  delegateTranscriptSessionId,
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
  onClose: () => void;
}) {
  const go = useDashboardNavigate();
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
  const headerContent = (
    <div className="delegate-inspector-header-content">
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
  if (inline)
    return (
      <div className="delegate-inspector-inline">
        <header className="surface-drawer-header delegate-inspector-inline-header">
          <div className="surface-drawer-heading">
            <p className="eyebrow">Delegate</p>
            <div className="surface-drawer-summary">
              {delegateDisplayName(displayedRow)}
            </div>
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
  DelegateInspectorMetadata,
  type DelegateInspectorRunOption,
  DelegateParentRequest,
  delegateDetailHasError,
  delegateTranscriptSessionId,
} from './detail-panel';
