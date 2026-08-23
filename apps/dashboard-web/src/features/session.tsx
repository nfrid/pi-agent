import {
  type DashboardLiveStore,
  selectSessionReplacement,
  useDashboardStore,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
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

export function SessionView({
  id,
  snapshot,
  store,
  Composer,
  embedded = false,
}: {
  id: string;
  snapshot: BrowserSnapshot;
  store: DashboardLiveStore;
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
  const sessionMounted = Boolean(data && projection);
  const {
    history,
    historyError,
    historyLoading,
    loadEarlierHistory,
    cancelScrollRestore,
    completePrependRestore,
    prependAnchor,
  } = useOlderSessionHistory({
    id,
    data,
    store,
    sessionMounted,
    scrollElementRef: embedded ? undefined : transcriptScrollRef,
  });

  useEffect(() => {
    if (outlineOpen) outlineWasOpenRef.current = true;
    else if (outlineWasOpenRef.current) {
      outlineWasOpenRef.current = false;
      outlineTriggerRef.current?.focus({ preventScroll: true });
    }
  }, [outlineOpen]);
  const {
    awayFromLatest,
    controlLayerRef,
    jumpToLatest,
    sessionPageRef,
    stopFollowing,
    tailReadySessionId,
    tailScrollRequest,
  } = useSessionScroll({
    id,
    data,
    projection,
    sessionMounted,
    enabled: !embedded,
    scrollElementRef: transcriptScrollRef,
  });
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
          {history?.hasOlder && (
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
            tailScrollRequest={tailScrollRequest}
            outlineOpen={outlineOpen}
            onOutlineOpenChange={setOutlineOpen}
            onBeforeScroll={handleBeforeTranscriptNavigation}
            scrollElementRef={embedded ? undefined : transcriptScrollRef}
            leadingContinuation={
              history?.hasOlder ? history.leadingContinuation : undefined
            }
            prependAnchor={prependAnchor}
            onPrependAnchorRestored={completePrependRestore}
            virtualize={!embedded}
          />
        </section>
        {data.metadata.sessionKind !== 'delegate' && (
          <SessionControlLayer
            controlLayerRef={controlLayerRef}
            awayFromLatest={awayFromLatest}
            onJumpToLatest={handleJumpToLatest}
            Composer={Composer}
            runtime={runtime}
            sessionChange={sessionChange}
            store={store}
            runtimes={snapshot.runtimes}
            session={data.metadata}
            sessionId={id}
            projectId={projectId}
            checkoutId={checkoutId}
            onPromptSubmitted={(text) => {
              cancelScrollRestore();
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
