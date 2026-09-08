import {
  type DashboardHttpClient,
  type DashboardLiveStore,
  selectSessionReplacement,
  useDashboardStore,
} from '@pi-dashboard/client';
import type {
  BrowserSnapshot,
  SessionIndexEntry,
} from '@pi-dashboard/protocol';
import {
  type ComponentType,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Transcript } from '../entities/transcript';
import { useDashboardNavigate } from '../routes/navigation';
import { AgentThreadNav, projectNameForSession } from './agent-thread-nav';
import { runtimePauseStatus } from './extension-surfaces';
import { dashboardStatus } from './presentation-status';
import { useOlderSessionHistory } from './session/history';
import { useSessionHydration } from './session/hydration';
import { useSessionScroll } from './session/scroll';
import {
  type SessionComposerProps,
  SessionControlLayer,
  SessionHeader,
  SessionHistoryControl,
  SessionLoadingCurtain,
  SessionLoadingHeader,
} from './session/views';
import { useSessionNavigation } from './session-navigation-context';

export { visualViewportKeyboardInset } from './session/viewport';

export function sessionAllowsControls(
  session: Pick<SessionIndexEntry, 'sessionKind'>,
): boolean {
  return session.sessionKind !== 'delegate';
}

export function SessionView({
  id,
  snapshot,
  store,
  client,
  Composer,
  embedded = false,
}: {
  id: string;
  snapshot: BrowserSnapshot;
  store: DashboardLiveStore;
  client: DashboardHttpClient;
  Composer: ComponentType<SessionComposerProps>;
  /** Render transcript controls without the full-page agent navigation shell. */
  embedded?: boolean;
}) {
  const go = useDashboardNavigate();
  const replaceSession = useCallback(
    (sessionId: string) => {
      go(`/sessions/${encodeURIComponent(sessionId)}`);
    },
    [go],
  );
  const replacementSessionId = useDashboardStore(
    store,
    selectSessionReplacement(id),
  );
  const sessionNavigation = useSessionNavigation();
  const [localAgentNavOpen, setLocalAgentNavOpen] = useState(false);
  const agentNavOpen = sessionNavigation?.open ?? localAgentNavOpen;
  const setAgentNavOpen = sessionNavigation?.setOpen ?? setLocalAgentNavOpen;
  const [outlineOpen, setOutlineOpen] = useState(false);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const outlineWasOpenRef = useRef(false);
  const {
    data,
    error,
    queryError,
    runtime,
    sessionChange,
    storedMetadata,
    projection,
    retrySession,
    waitingForInitialHistory,
  } = useSessionHydration({
    id,
    store,
    onReplacement: replaceSession,
  });
  const sessionMounted = Boolean(
    data && projection && !waitingForInitialHistory,
  );
  const tailStateRef = useRef({ ready: false, restoring: true });
  const {
    history,
    historyError,
    historyLoading,
    loadEarlierHistory,
    loadThroughOrdinal,
    cancelScrollRestore,
    completePrependRestore,
    prependAnchor,
  } = useOlderSessionHistory({
    id,
    data,
    store,
    client,
    sessionMounted,
    scrollElementRef: embedded ? undefined : transcriptScrollRef,
    autoloadAtTop: !embedded
      ? () => tailStateRef.current.ready && !tailStateRef.current.restoring
      : false,
  });
  const {
    awayFromLatest,
    controlLayerRef,
    jumpToLatest,
    sessionPageRef,
    stopFollowing,
    tailReadySessionId,
    scrollCommand,
    restoring,
  } = useSessionScroll({
    id,
    serverId: snapshot.serverId,
    history,
    historyAvailable: data?.history !== undefined,
    loadThroughOrdinal,
    cancelHistoryRestore: cancelScrollRestore,
    data,
    projection,
    sessionMounted,
    enabled: !embedded,
    scrollElementRef: transcriptScrollRef,
  });
  tailStateRef.current = {
    ready: tailReadySessionId === id,
    restoring,
  };

  useEffect(() => {
    if (outlineOpen) outlineWasOpenRef.current = true;
    else if (outlineWasOpenRef.current) {
      outlineWasOpenRef.current = false;
      outlineTriggerRef.current?.focus({ preventScroll: true });
    }
  }, [outlineOpen]);
  const handleJumpToLatest = useCallback(() => {
    cancelScrollRestore();
    jumpToLatest();
  }, [cancelScrollRestore, jumpToLatest]);
  const handleBeforeTranscriptNavigation = useCallback(() => {
    cancelScrollRestore();
    stopFollowing();
  }, [cancelScrollRestore, stopFollowing]);
  useEffect(() => {
    if (replacementSessionId && replacementSessionId !== id)
      replaceSession(replacementSessionId);
  }, [id, replaceSession, replacementSessionId]);

  const pauseStatus = runtimePauseStatus(runtime);
  const presentation = dashboardStatus(runtime);
  const status = presentation.status === 'idle' ? 'ready' : presentation.status;
  const statusLabel =
    presentation.status === 'idle' ? 'ready' : presentation.label;
  if (!data || !projection || waitingForInitialHistory) {
    return (
      <div
        className={`${sessionNavigation ? 'session-route-content' : 'session-layout'}${embedded ? ' embedded-session-layout' : ''}`}
      >
        {!embedded && !sessionNavigation && (
          <AgentThreadNav
            snapshot={snapshot}
            mode="session"
            currentSessionId={id}
            open={agentNavOpen}
            onOpenChange={setAgentNavOpen}
          />
        )}
        <section
          className={`session-page session-page-loading${embedded ? ' session-page-embedded' : ''}`}
        >
          <SessionLoadingHeader
            id={id}
            metadata={storedMetadata}
            runtime={runtime}
            status={status}
            statusLabel={statusLabel}
          />
        </section>
        {!embedded && (
          <SessionLoadingCurtain
            error={error}
            queryError={queryError}
            onRetry={retrySession}
          />
        )}
      </div>
    );
  }

  const projectName = projectNameForSession(snapshot, data.metadata, runtime);
  const projectId = runtime?.projectId ?? data.metadata.projectId ?? undefined;
  const checkoutId =
    runtime?.checkoutId ?? data.metadata.checkoutId ?? undefined;
  const checkout = snapshot.checkouts?.find(
    (candidate) => candidate.id === checkoutId,
  );
  return (
    <div
      className={`${sessionNavigation ? 'session-route-content' : 'session-layout'}${embedded ? ' embedded-session-layout' : ''}`}
    >
      {!embedded && !sessionNavigation && (
        <AgentThreadNav
          snapshot={snapshot}
          mode="session"
          currentSessionId={id}
          open={agentNavOpen}
          onOpenChange={setAgentNavOpen}
        />
      )}
      <section
        ref={sessionPageRef}
        data-tail-pending={
          !embedded && tailReadySessionId !== id ? '' : undefined
        }
        data-runtime-paused={pauseStatus ? '' : undefined}
        className={`session-page${embedded ? ' session-page-embedded' : ''}${agentNavOpen ? ' modal-open' : ''}`}
      >
        <SessionHeader
          id={id}
          projectName={projectName}
          projectId={projectId}
          data={data.metadata}
          entries={data.entries}
          status={status}
          statusLabel={statusLabel}
          outlineTriggerRef={outlineTriggerRef}
          onOpenOutline={() => setOutlineOpen(true)}
          store={store}
          sessions={snapshot.sessions}
        />
        <section
          ref={transcriptScrollRef}
          className="session-transcript-scroll"
          aria-label="Transcript"
        >
          {historyError && (
            <SessionHistoryControl
              loading={historyLoading}
              error={historyError}
              onLoad={() => void loadEarlierHistory()}
            />
          )}
          <Transcript
            key={id}
            projection={projection}
            runtime={runtime}
            cwd={runtime?.cwd ?? data.metadata.cwd}
            outlineOpen={outlineOpen}
            onOutlineOpenChange={setOutlineOpen}
            onBeforeScroll={handleBeforeTranscriptNavigation}
            scrollElementRef={embedded ? undefined : transcriptScrollRef}
            outline={data.outline}
            branchTopology={data.branchTopology}
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
            scrollCommand={scrollCommand}
            virtualize={!embedded}
          />
        </section>
        {sessionAllowsControls(data.metadata) && (
          <SessionControlLayer
            controlLayerRef={controlLayerRef}
            awayFromLatest={awayFromLatest}
            onJumpToLatest={handleJumpToLatest}
            Composer={Composer}
            runtime={runtime}
            sessionChange={sessionChange}
            store={store}
            client={client}
            runtimes={snapshot.runtimes}
            session={data.metadata}
            sessionId={id}
            projectId={projectId}
            checkoutId={checkoutId}
            checkout={checkout}
            onPromptSubmitted={(text) => {
              cancelScrollRestore();
              if (restoring) stopFollowing();
              store.optimisticallyTitleSession(id, text);
            }}
          />
        )}
      </section>
      {!embedded && tailReadySessionId !== id && (
        <SessionLoadingCurtain
          error={error}
          queryError={queryError}
          onRetry={retrySession}
        />
      )}
    </div>
  );
}
