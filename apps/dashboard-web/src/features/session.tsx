import {
  type DashboardLiveStore,
  selectSessionReplacement,
  useDashboardStore,
} from '@pi-dashboard/client';
import { type BrowserSnapshot, workspaceForPath } from '@pi-dashboard/protocol';
import {
  type ComponentType,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Transcript } from '../entities/transcript';
import { useDashboardNavigate } from '../routes/navigation';
import { AgentThreadNav, workspaceNameForSession } from './agent-thread-nav';
import { runtimePauseStatus } from './extension-surfaces';
import { PendingInteractions } from './pending-interaction';
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

export type { InteractionKeyAction } from './pending-interaction';
export {
  interactionKeyAction,
  selectedInteractionPreview,
} from './pending-interaction';
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
  const [agentNavOpen, setAgentNavOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const outlineWasOpenRef = useRef(false);
  const {
    data,
    error,
    queryError,
    runtime,
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
  const { history, historyError, historyLoading, loadEarlierHistory } =
    useOlderSessionHistory({
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
  useEffect(() => {
    // A pending question is a higher-priority modal than the optional
    // transcript surfaces; never leave fixed surfaces competing for the viewport.
    if (runtime?.pendingInteractions.length) {
      setAgentNavOpen(false);
      setOutlineOpen(false);
    }
  }, [runtime?.pendingInteractions.length]);
  const {
    awayFromLatest,
    controlLayerRef,
    jumpToLatest,
    sessionPageRef,
    tailReadySessionId,
    tailScrollRequest,
  } = useSessionScroll({
    id,
    data,
    projection,
    sessionMounted,
    scrollElementRef: transcriptScrollRef,
  });
  useEffect(() => {
    if (replacementSessionId && replacementSessionId !== id)
      replaceSession(replacementSessionId);
  }, [id, replaceSession, replacementSessionId]);

  const pauseStatus = runtimePauseStatus(runtime);
  const status = runtime
    ? runtime.online === false
      ? 'offline'
      : pauseStatus
        ? 'paused'
        : runtime.liveState === 'idle'
          ? 'ready'
          : runtime.liveState
    : 'dormant';
  const statusLabel = pauseStatus?.label ?? status;
  if (!data || !projection || waitingForInitialHistory) {
    return (
      <div
        className={`session-layout${embedded ? ' embedded-session-layout' : ''}`}
      >
        {!embedded && (
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
          <PendingInteractions runtime={runtime} />
        </section>
        <SessionLoadingCurtain
          error={error}
          queryError={queryError}
          onRetry={retrySession}
        />
      </div>
    );
  }

  const hasPendingInteraction = Boolean(runtime?.pendingInteractions.length);
  const workspaceName = workspaceNameForSession(
    snapshot,
    data.metadata,
    runtime,
  );
  const workspaceId =
    data.metadata.workspaceId ??
    workspaceForPath(runtime?.cwd ?? data.metadata.cwd, snapshot.workspaces)
      ?.id;
  return (
    <div
      className={`session-layout${embedded ? ' embedded-session-layout' : ''}`}
    >
      {!embedded && (
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
        data-tail-pending={tailReadySessionId === id ? undefined : ''}
        data-runtime-paused={pauseStatus ? '' : undefined}
        className={`session-page${embedded ? ' session-page-embedded' : ''}${hasPendingInteraction ? ' has-pending-interaction' : ''}${agentNavOpen ? ' modal-open' : ''}`}
      >
        <SessionHeader
          id={id}
          workspaceName={workspaceName}
          data={data.metadata}
          entries={data.entries}
          status={status}
          statusLabel={statusLabel}
          outlineTriggerRef={outlineTriggerRef}
          onOpenOutline={() => setOutlineOpen(true)}
          store={store}
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
            scrollElementRef={embedded ? undefined : transcriptScrollRef}
            virtualize={!embedded}
          />
        </section>
        <SessionControlLayer
          controlLayerRef={controlLayerRef}
          awayFromLatest={awayFromLatest}
          onJumpToLatest={jumpToLatest}
          Composer={Composer}
          runtime={runtime}
          runtimes={snapshot.runtimes}
          sessionId={id}
          workspaceId={workspaceId}
          onPromptSubmitted={(text) => {
            store.optimisticallyTitleSession(id, text);
          }}
        />
        <PendingInteractions runtime={runtime} />
      </section>
      {tailReadySessionId !== id && (
        <SessionLoadingCurtain
          error={error}
          queryError={queryError}
          onRetry={retrySession}
        />
      )}
    </div>
  );
}
