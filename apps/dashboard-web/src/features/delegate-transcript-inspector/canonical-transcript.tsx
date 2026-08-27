import {
  type DashboardLiveStore,
  selectRuntimeForSession,
  selectSessionSnapshot,
  selectTranscript,
  useDashboardStore,
} from '@pi-dashboard/client';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Transcript } from '../../entities/transcript';
import { toTranscriptEntries } from '../../transcript';
import type { DelegateInspectionStatus } from '../delegate/history-compose';
import { useOlderSessionHistory } from '../session/history';
import { useSessionScroll } from '../session/scroll';
import { SessionHistoryControl } from '../session/views';
import { DelegateTranscript } from './adaptation';
import {
  type DelegateInspectorDetailState,
  type DelegateInspectorRunOption,
  DelegateParentRequest,
} from './detail-panel';

function DelegateBoundedFallback({
  row,
  reason,
  omitTasks = false,
}: {
  row: DelegateInspectionStatus;
  reason: string;
  omitTasks?: boolean;
}) {
  const entries = omitTasks
    ? (row.transcript ?? []).filter((entry) => entry.type !== 'task')
    : (row.transcript ?? []);
  return (
    <section aria-label="Bounded delegate transcript fallback">
      <p className="delegate-transcript-truncated">{reason}</p>
      {entries.length > 0 || row.transcriptTruncated ? (
        <DelegateTranscript
          entries={entries}
          truncated={row.transcriptTruncated === true}
          truncatedMessage={
            row.historyIncomplete
              ? 'Delegate history is incomplete; some historical runs or transcript entries were omitted from this view.'
              : row.historical
                ? 'Earlier historical transcript entries were omitted from this view.'
                : undefined
          }
        />
      ) : (
        <p className="delegate-transcript-empty">
          Waiting for bounded delegate transcript activity.
        </p>
      )}
    </section>
  );
}

function DelegateCanonicalTranscript({
  sessionId,
  store,
  fallback,
  isOpen,
  scrollElementRef,
  runOptions,
  detail,
  onRunSelected,
}: {
  sessionId: string;
  store: DashboardLiveStore;
  fallback: DelegateInspectionStatus;
  isOpen: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  runOptions: readonly DelegateInspectorRunOption[];
  detail?: DelegateInspectorDetailState;
  onRunSelected?: (run: DelegateInspectorRunOption) => void;
}) {
  const projection = useDashboardStore(store, selectTranscript(sessionId));
  const runtime = useDashboardStore(store, selectRuntimeForSession(sessionId));
  const snapshot = useDashboardStore(store, selectSessionSnapshot(sessionId));
  const sync = useDashboardStore(
    store,
    (state) => state.sessionSyncById[sessionId],
  );
  const fallbackScrollRef = useRef<HTMLDivElement>(null);
  const [requestedRunId, setRequestedRunId] = useState<string>();
  const transcriptScrollRef = scrollElementRef ?? fallbackScrollRef;
  useEffect(() => {
    const handle = store.acquireSession(sessionId);
    return () => handle?.release();
  }, [sessionId, store]);
  const mounted = Boolean(projection && snapshot?.metadata.id === sessionId);
  const follow = useSessionScroll({
    id: sessionId,
    data: snapshot,
    projection,
    sessionMounted: mounted,
    enabled: isOpen,
    scrollElementRef: transcriptScrollRef,
  });
  const {
    history,
    historyError,
    historyLoading,
    loadEarlierHistory,
    loadThroughOrdinal,
    completePrependRestore,
    prependAnchor,
  } = useOlderSessionHistory({
    id: sessionId,
    data: snapshot,
    store,
    sessionMounted: mounted,
    autoloadAll: true,
  });
  const modelItems = useMemo(() => {
    if (!projection) return undefined;
    let requestIndex = 0;
    return toTranscriptEntries(projection).map((item) => {
      if (item.role !== 'user' || item.deliveryMode) return item;
      const index = requestIndex++;
      const run = runOptions[index];
      if (!run) return item;
      const runDetails =
        detail?.run?.runId === run.id ? detail.run.run.details : undefined;
      const task =
        runDetails?.task ??
        run.row.details?.task ??
        run.row.task ??
        'Delegate request';
      return {
        ...item,
        text: task,
        customMessage: (
          <DelegateParentRequest
            run={run}
            index={index}
            details={runDetails}
            loading={detail?.loading === true && requestedRunId === run.id}
            error={detail?.error != null && requestedRunId === run.id}
            onDetailsRequested={() => {
              setRequestedRunId(run.id);
              onRunSelected?.(run);
            }}
          />
        ),
        landmark: {
          label: task.replace(/\s+/gu, ' ').trim().slice(0, 240),
          typeLabel: index === 0 ? 'Parent request' : 'Parent follow-up',
          variant: 'delegate-request',
        },
      };
    });
  }, [detail, onRunSelected, projection, requestedRunId, runOptions]);
  const delegateOutline = useMemo(() => {
    if (!snapshot?.outline) return snapshot?.outline;
    let requestIndex = 0;
    return snapshot.outline.map((landmark) => {
      if (landmark.kind !== 'user') return landmark;
      const run = runOptions[requestIndex++];
      if (!run) return landmark;
      const task = run.row.details?.task ?? run.row.task;
      return task
        ? {
            ...landmark,
            label: task.replace(/\s+/gu, ' ').trim().slice(0, 240),
          }
        : landmark;
    });
  }, [runOptions, snapshot?.outline]);
  if (!mounted)
    return (
      <DelegateBoundedFallback
        row={fallback}
        reason={
          sync?.status === 'error'
            ? 'Limited transcript — the child session is unavailable.'
            : 'Limited transcript — connecting to the child session.'
        }
      />
    );
  return (
    <section
      ref={follow.sessionPageRef}
      className="delegate-canonical-session-transcript"
      aria-label="Canonical child session transcript"
    >
      {(historyLoading || historyError) &&
        (historyError ? (
          <SessionHistoryControl
            loading={historyLoading}
            error={historyError}
            onLoad={() => void loadEarlierHistory()}
          />
        ) : (
          <output className="delegate-transcript-loading">
            Loading earlier child session history…
          </output>
        ))}
      <Transcript
        modelItems={modelItems}
        runtime={runtime}
        tailScrollRequest={follow.tailScrollRequest}
        onBeforeScroll={follow.stopFollowing}
        scrollElementRef={transcriptScrollRef}
        outline={delegateOutline}
        onJumpToLandmark={(landmark) =>
          landmark.ordinal < (history?.start ?? Number.POSITIVE_INFINITY)
            ? loadThroughOrdinal(landmark.ordinal)
            : true
        }
        leadingContinuation={
          history?.hasOlder ? history.leadingContinuation : undefined
        }
        prependAnchor={prependAnchor}
        onPrependAnchorRestored={completePrependRestore}
      />
      <div
        ref={follow.controlLayerRef}
        className="delegate-transcript-follow-control"
      >
        {follow.awayFromLatest && (
          <button
            type="button"
            className="session-icon-button jump-latest"
            onClick={follow.jumpToLatest}
            aria-label="Jump to latest delegate transcript activity"
          >
            Jump to latest
          </button>
        )}
      </div>
    </section>
  );
}

function DelegateBoundedRequests({
  runOptions,
  detail,
  onRunSelected,
}: {
  runOptions: readonly DelegateInspectorRunOption[];
  detail?: DelegateInspectorDetailState;
  onRunSelected?: (run: DelegateInspectorRunOption) => void;
}) {
  const [requestedRunId, setRequestedRunId] = useState<string>();
  return runOptions.map((run, index) => (
    <div data-transcript-key={`delegate-request-${run.id}`} key={run.id}>
      <DelegateParentRequest
        run={run}
        index={index}
        details={
          detail?.run?.runId === run.id ? detail.run.run.details : undefined
        }
        loading={detail?.loading === true && requestedRunId === run.id}
        error={detail?.error != null && requestedRunId === run.id}
        onDetailsRequested={() => {
          setRequestedRunId(run.id);
          onRunSelected?.(run);
        }}
      />
    </div>
  ));
}

export function DelegateInspectorTranscript({
  row,
  store,
  isOpen,
  scrollElementRef,
  runOptions = [],
  detail,
  onRunSelected,
}: {
  row: DelegateInspectionStatus;
  store?: DashboardLiveStore;
  isOpen: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  runOptions?: readonly DelegateInspectorRunOption[];
  detail?: DelegateInspectorDetailState;
  onRunSelected?: (run: DelegateInspectorRunOption) => void;
}) {
  return isOpen && row.sessionId && store ? (
    <DelegateCanonicalTranscript
      key={row.sessionId}
      sessionId={row.sessionId}
      store={store}
      fallback={row}
      isOpen={isOpen}
      scrollElementRef={scrollElementRef}
      runOptions={runOptions}
      detail={detail}
      onRunSelected={onRunSelected}
    />
  ) : (
    <>
      <DelegateBoundedRequests
        runOptions={runOptions}
        detail={detail}
        onRunSelected={onRunSelected}
      />
      <DelegateBoundedFallback
        row={row}
        omitTasks={runOptions.length > 0}
        reason={
          row.sessionId
            ? 'Limited transcript — open this delegate to load its child session.'
            : 'Limited transcript — this older delegate has no child session.'
        }
      />
    </>
  );
}
