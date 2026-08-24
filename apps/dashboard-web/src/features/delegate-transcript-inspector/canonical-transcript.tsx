import {
  type DashboardLiveStore,
  selectRuntimeForSession,
  selectSessionSnapshot,
  selectTranscript,
  useDashboardStore,
} from '@pi-dashboard/client';
import { type RefObject, useEffect, useRef } from 'react';
import { Transcript } from '../../entities/transcript';
import type { DelegateInspectionStatus } from '../delegate/history-compose';
import { useOlderSessionHistory } from '../session/history';
import { useSessionScroll } from '../session/scroll';
import { SessionHistoryControl } from '../session/views';
import { DelegateTranscript } from './adaptation';

function DelegateBoundedFallback({
  row,
  reason,
}: {
  row: DelegateInspectionStatus;
  reason: string;
}) {
  const entries = row.transcript ?? [];
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
}: {
  sessionId: string;
  store: DashboardLiveStore;
  fallback: DelegateInspectionStatus;
  isOpen: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
}) {
  const projection = useDashboardStore(store, selectTranscript(sessionId));
  const runtime = useDashboardStore(store, selectRuntimeForSession(sessionId));
  const snapshot = useDashboardStore(store, selectSessionSnapshot(sessionId));
  const sync = useDashboardStore(
    store,
    (state) => state.sessionSyncById[sessionId],
  );
  const fallbackScrollRef = useRef<HTMLDivElement>(null);
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
        projection={projection}
        runtime={runtime}
        tailScrollRequest={follow.tailScrollRequest}
        onBeforeScroll={follow.stopFollowing}
        scrollElementRef={transcriptScrollRef}
        outline={snapshot?.outline}
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
    </section>
  );
}

export function DelegateInspectorTranscript({
  row,
  store,
  isOpen,
  scrollElementRef,
}: {
  row: DelegateInspectionStatus;
  store?: DashboardLiveStore;
  isOpen: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
}) {
  return isOpen && row.sessionId && store ? (
    <DelegateCanonicalTranscript
      key={row.sessionId}
      sessionId={row.sessionId}
      store={store}
      fallback={row}
      isOpen={isOpen}
      scrollElementRef={scrollElementRef}
    />
  ) : (
    <DelegateBoundedFallback
      row={row}
      reason={
        row.sessionId
          ? 'Limited transcript — open this delegate to load its child session.'
          : 'Limited transcript — this older delegate has no child session.'
      }
    />
  );
}
