import {
  type DashboardLiveStore,
  dashboardHttpClient,
  selectRuntimeForSession,
  selectSessionReplacement,
  sessionQueryOptions,
  useDashboardStore,
} from '@pi-dashboard/client';
import {
  type BrowserSnapshot,
  type RuntimeSnapshot,
  type SessionApiResponse,
  workspaceForPath,
} from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import {
  type ComponentType,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  isNearPageBottom,
  sessionDisplayTitle,
  shouldShowJumpToLatest,
} from '../app-helpers';
import { Transcript } from '../entities/transcript';
import { useDashboardNavigate } from '../routes/navigation';
import { AgentThreadNav, workspaceNameForSession } from './agent-thread-nav';
import { DashboardDialog } from './dashboard-dialog';
import {
  ExtensionSurfaceStack,
  runtimePauseStatus,
} from './extension-surfaces';
import { PendingInteractions } from './pending-interaction';
import { RuntimeActions } from './runtime-actions';
import { SessionRename } from './session-rename';

export type { InteractionKeyAction } from './pending-interaction';
export {
  interactionKeyAction,
  selectedInteractionPreview,
} from './pending-interaction';

type ComposerProps = {
  runtime: RuntimeSnapshot | undefined;
  runtimes?: readonly RuntimeSnapshot[];
  sessionId: string;
  workspaceId?: string;
  onMessageSubmitted?: () => void;
  onPromptSubmitted?: (text: string) => void;
};

export function visualViewportKeyboardInset(
  layoutHeight: number,
  viewportHeight: number,
  viewportOffsetTop: number,
): number {
  return Math.max(0, layoutHeight - viewportHeight - viewportOffsetTop);
}

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
  Composer: ComponentType<ComposerProps>;
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
  const query = useQuery(sessionQueryOptions(dashboardHttpClient, id));
  const projection = useDashboardStore(
    store,
    (state) => state.transcriptsBySessionId[id],
  );
  const storedMetadata = useDashboardStore(
    store,
    (state) => state.sessionsById[id],
  );
  const resyncNonce = useDashboardStore(store, (state) => state.resyncNonce);
  const runtime = useDashboardStore(store, selectRuntimeForSession(id));
  const replacementSessionId = useDashboardStore(
    store,
    selectSessionReplacement(id),
  );
  const data = query.data
    ? { ...query.data, metadata: storedMetadata ?? query.data.metadata }
    : undefined;
  const [error, setError] = useState<string>();
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [agentNavOpen, setAgentNavOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [incompleteRetryNonce, setIncompleteRetryNonce] = useState(0);
  const [history, setHistory] = useState<SessionApiResponse['history']>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [tailScrollRequest, setTailScrollRequest] = useState(0);
  const closeInspector = useCallback(() => setInspectorOpen(false), []);
  const scrolledSessionRef = useRef<string | undefined>(undefined);
  const autoScrollFrameRef = useRef<number | undefined>(undefined);
  const layoutScrollFrameRef = useRef<number | undefined>(undefined);
  const initialTailSessionRef = useRef<string | undefined>(undefined);
  const initialTailSettleTimerRef = useRef<number | undefined>(undefined);
  const [tailReadySessionId, setTailReadySessionId] = useState<
    string | undefined
  >(undefined);
  const userScrollIntentRef = useRef(false);
  const runtimeReconcileTimerRef = useRef<number | undefined>(undefined);
  const runtimeWasOnlineRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const outlineWasOpenRef = useRef(false);
  const sessionPageRef = useRef<HTMLElement>(null);
  const controlLayerRef = useRef<HTMLDivElement>(null);
  const incompleteRetryCountRef = useRef(0);
  const hydrationRetryCountRef = useRef(0);
  const historySessionRef = useRef<string | undefined>(undefined);
  const historyGenerationRef = useRef(0);
  const historyRequestRef = useRef<
    | {
        id: string;
        generation: number;
        controller: AbortController;
      }
    | undefined
  >(undefined);
  const sessionRefetchRef = useRef<
    ReturnType<typeof query.refetch> | undefined
  >(undefined);
  const requestSessionRefetch = useCallback(() => {
    if (document.visibilityState !== 'visible') return undefined;
    if (sessionRefetchRef.current) return sessionRefetchRef.current;
    const pending = query.refetch();
    sessionRefetchRef.current = pending;
    void pending.then(
      () => {
        if (sessionRefetchRef.current === pending)
          sessionRefetchRef.current = undefined;
      },
      () => {
        if (sessionRefetchRef.current === pending)
          sessionRefetchRef.current = undefined;
      },
    );
    return pending;
  }, [query.refetch]);
  useLayoutEffect(() => {
    // SessionRoute is reused while only the route id changes. Arm the new
    // session before its existing projection can paint at the old scroll
    // position.
    initialTailSessionRef.current = id;
    userScrollIntentRef.current = false;
    stickToBottomRef.current = true;
    setTailReadySessionId(undefined);
    setAwayFromLatest(false);
    if (initialTailSettleTimerRef.current !== undefined) {
      window.clearTimeout(initialTailSettleTimerRef.current);
      initialTailSettleTimerRef.current = undefined;
    }
  }, [id]);
  useEffect(() => {
    if (!id) return;
    setError(undefined);
    hydrationRetryCountRef.current = 0;
    incompleteRetryCountRef.current = 0;
    historyGenerationRef.current += 1;
    historyRequestRef.current?.controller.abort();
    historyRequestRef.current = undefined;
    historySessionRef.current = undefined;
    setHistory(undefined);
    setHistoryLoading(false);
    setHistoryError(undefined);
    return () => {
      historyGenerationRef.current += 1;
      historyRequestRef.current?.controller.abort();
      historyRequestRef.current = undefined;
    };
  }, [id]);
  useEffect(() => {
    if (
      query.data?.metadata.id === id &&
      query.data.history &&
      historySessionRef.current !== id
    ) {
      historySessionRef.current = id;
      setHistory(query.data.history);
    }
  }, [id, query.data]);
  useEffect(() => {
    // A refetch can reuse structurally equal data; its timestamp still marks a
    // new hydration attempt that must be evaluated.
    void query.dataUpdatedAt;
    if (!query.data) return;
    if (query.data.metadata.id !== id) {
      replaceSession(query.data.metadata.id);
      return;
    }
    if (store.hydrateSession(query.data)) {
      hydrationRetryCountRef.current = 0;
      if (query.data.entriesComplete !== false) setError(undefined);
      return;
    }
    const attempt = hydrationRetryCountRef.current;
    if (attempt >= 6) {
      setError('Session changed repeatedly while loading. Retry when ready.');
      return;
    }
    hydrationRetryCountRef.current = attempt + 1;
    setError('Session changed while loading; retrying…');
    const retry = window.setTimeout(
      () => void requestSessionRefetch(),
      Math.min(8_000, 250 * 2 ** attempt),
    );
    return () => window.clearTimeout(retry);
  }, [
    id,
    query.data,
    query.dataUpdatedAt,
    replaceSession,
    requestSessionRefetch,
    store,
  ]);
  useEffect(() => {
    if (resyncNonce > 0) void requestSessionRefetch();
  }, [requestSessionRefetch, resyncNonce]);
  useEffect(() => {
    const online = Boolean(runtime && runtime.online !== false);
    const wasOnline = runtimeWasOnlineRef.current;
    runtimeWasOnlineRef.current = online;
    if (!wasOnline || online) return;
    // A short-lived print/runtime can exit immediately after its terminal
    // event. Re-read once after shutdown, when Pi's JSONL branch is durable.
    if (runtimeReconcileTimerRef.current !== undefined)
      window.clearTimeout(runtimeReconcileTimerRef.current);
    runtimeReconcileTimerRef.current = window.setTimeout(() => {
      runtimeReconcileTimerRef.current = undefined;
      void requestSessionRefetch();
    }, 500);
  }, [requestSessionRefetch, runtime]);
  useEffect(() => {
    const reconcileWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      hydrationRetryCountRef.current = 0;
      incompleteRetryCountRef.current = 0;
      setIncompleteRetryNonce((current) => current + 1);
      void requestSessionRefetch();
    };
    document.addEventListener('visibilitychange', reconcileWhenVisible);
    return () =>
      document.removeEventListener('visibilitychange', reconcileWhenVisible);
  }, [requestSessionRefetch]);
  useEffect(() => {
    // Visibility increments this nonce to restart a previously suspended retry loop.
    void incompleteRetryNonce;
    if (query.data?.entriesComplete !== false) {
      incompleteRetryCountRef.current = 0;
      return;
    }
    let canceled = false;
    let timer: number | undefined;
    const retry = () => {
      if (canceled || document.visibilityState !== 'visible') return;
      if (incompleteRetryCountRef.current >= 6) {
        setError('Session history is not ready yet. Retry when ready.');
        return;
      }
      const attempt = incompleteRetryCountRef.current;
      timer = window.setTimeout(
        async () => {
          if (canceled || document.visibilityState !== 'visible') return;
          incompleteRetryCountRef.current = attempt + 1;
          const result = await requestSessionRefetch();
          if (!canceled && result?.data?.entriesComplete === false) retry();
        },
        Math.min(8_000, 500 * 2 ** attempt),
      );
    };
    retry();
    return () => {
      canceled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    incompleteRetryNonce,
    query.data?.entriesComplete,
    requestSessionRefetch,
  ]);
  useEffect(() => {
    if (outlineOpen) outlineWasOpenRef.current = true;
    else if (outlineWasOpenRef.current) {
      outlineWasOpenRef.current = false;
      outlineTriggerRef.current?.focus({ preventScroll: true });
    }
  }, [outlineOpen]);
  useEffect(() => {
    // A pending question is a higher-priority modal than the optional
    // inspector; never leave either fixed surface competing for the viewport.
    if (runtime?.pendingInteractions.length) {
      setInspectorOpen(false);
      setAgentNavOpen(false);
      setOutlineOpen(false);
    }
  }, [runtime?.pendingInteractions.length]);
  useEffect(() => {
    const cancelPendingTailScroll = () => {
      userScrollIntentRef.current = true;
      stickToBottomRef.current = false;
      initialTailSessionRef.current = undefined;
      setTailReadySessionId(id);
      if (initialTailSettleTimerRef.current !== undefined) {
        window.clearTimeout(initialTailSettleTimerRef.current);
        initialTailSettleTimerRef.current = undefined;
      }
      if (autoScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = undefined;
      }
      if (layoutScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
        layoutScrollFrameRef.current = undefined;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = document.documentElement;
      if (
        event.clientX >= root.clientWidth ||
        event.clientY >= root.clientHeight
      )
        cancelPendingTailScroll();
    };
    let touchY: number | undefined;
    let previousScrollY = window.scrollY;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) cancelPendingTailScroll();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined && nextY > touchY)
        cancelPendingTailScroll();
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, [contenteditable="true"], [role="textbox"]',
        )
      )
        return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.code))
        cancelPendingTailScroll();
    };
    const update = () => {
      const scrolledUp = window.scrollY < previousScrollY - 1;
      previousScrollY = window.scrollY;
      if (scrolledUp && initialTailSessionRef.current !== id)
        cancelPendingTailScroll();
      const nearLatest = isNearPageBottom(
        document.documentElement.scrollHeight,
        window.scrollY,
        window.innerHeight,
      );
      if (stickToBottomRef.current && !userScrollIntentRef.current) {
        setAwayFromLatest(false);
        if (!nearLatest && layoutScrollFrameRef.current === undefined) {
          layoutScrollFrameRef.current = window.requestAnimationFrame(() => {
            layoutScrollFrameRef.current = undefined;
            if (stickToBottomRef.current && !userScrollIntentRef.current)
              window.scrollTo(0, document.documentElement.scrollHeight);
          });
        }
        return;
      }
      if (nearLatest) {
        userScrollIntentRef.current = false;
        stickToBottomRef.current = true;
      }
      setAwayFromLatest(
        shouldShowJumpToLatest(
          document.documentElement.scrollHeight,
          window.scrollY,
          window.innerHeight,
        ),
      );
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    update();
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [id]);
  useLayoutEffect(() => {
    if (!data || !projection) return;
    const enteringSession = scrolledSessionRef.current !== id;
    if (enteringSession) {
      userScrollIntentRef.current = false;
      stickToBottomRef.current = true;
      initialTailSessionRef.current = id;
      if (initialTailSettleTimerRef.current !== undefined) {
        window.clearTimeout(initialTailSettleTimerRef.current);
        initialTailSettleTimerRef.current = undefined;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
    if (enteringSession && autoScrollFrameRef.current !== undefined) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = undefined;
    }
    if (!enteringSession && !stickToBottomRef.current) return;
    scrolledSessionRef.current = id;
    if (autoScrollFrameRef.current !== undefined) return;
    const frame = window.requestAnimationFrame(() => {
      if (autoScrollFrameRef.current === frame)
        autoScrollFrameRef.current = undefined;
      // Virtualization can increase the document height before this frame and
      // make the scroll listener clear stickiness. Entering a session must
      // still establish the initial tail position.
      if (
        userScrollIntentRef.current ||
        (!enteringSession && !stickToBottomRef.current)
      ) {
        setTailReadySessionId(id);
        return;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      stickToBottomRef.current = true;
      setTailReadySessionId(id);
      if (initialTailSettleTimerRef.current !== undefined)
        window.clearTimeout(initialTailSettleTimerRef.current);
      initialTailSettleTimerRef.current = window.setTimeout(() => {
        initialTailSettleTimerRef.current = undefined;
        if (initialTailSessionRef.current === id)
          initialTailSessionRef.current = undefined;
      }, 400);
    });
    autoScrollFrameRef.current = frame;
    return () => {
      if (autoScrollFrameRef.current !== frame) return;
      window.cancelAnimationFrame(frame);
      autoScrollFrameRef.current = undefined;
    };
  }, [data, projection, id]);
  useEffect(
    () => () => {
      if (autoScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = undefined;
      }
      if (layoutScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
        layoutScrollFrameRef.current = undefined;
      }
      if (initialTailSettleTimerRef.current !== undefined) {
        window.clearTimeout(initialTailSettleTimerRef.current);
        initialTailSettleTimerRef.current = undefined;
      }
      if (runtimeReconcileTimerRef.current !== undefined) {
        window.clearTimeout(runtimeReconcileTimerRef.current);
        runtimeReconcileTimerRef.current = undefined;
      }
    },
    [],
  );
  const sessionMounted = Boolean(data && projection);
  useLayoutEffect(() => {
    void id;
    if (!sessionMounted) return;
    const page = sessionPageRef.current;
    const controlLayer = controlLayerRef.current;
    if (!page || !controlLayer) return;
    const update = (preserveLatest: boolean) => {
      const viewport = window.visualViewport;
      const keyboardInset = viewport
        ? visualViewportKeyboardInset(
            window.innerHeight,
            viewport.height,
            viewport.offsetTop,
          )
        : 0;
      page.style.setProperty(
        '--session-control-height',
        `${Math.ceil(controlLayer.getBoundingClientRect().height)}px`,
      );
      page.style.setProperty(
        '--keyboard-inset',
        `${Math.ceil(keyboardInset)}px`,
      );
      page.toggleAttribute('data-keyboard-open', keyboardInset > 0);
      const initialTailPending =
        initialTailSessionRef.current === id && !userScrollIntentRef.current;
      if (
        !preserveLatest ||
        (!stickToBottomRef.current && !initialTailPending) ||
        userScrollIntentRef.current
      )
        return;
      if (layoutScrollFrameRef.current !== undefined)
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
      layoutScrollFrameRef.current = window.requestAnimationFrame(() => {
        layoutScrollFrameRef.current = undefined;
        if (
          (!stickToBottomRef.current && initialTailSessionRef.current !== id) ||
          userScrollIntentRef.current
        )
          return;
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
    };
    const onResize = () => update(true);
    const onViewportScroll = () => update(false);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(onResize);
    // The transcript, especially its virtualized rows, can finish measuring
    // after the first navigation frame. Keep a newly opened session pinned to
    // its tail while the page height settles, unless the user scrolls away.
    observer?.observe(page);
    observer?.observe(controlLayer);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onViewportScroll);
    update(true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onViewportScroll);
      if (layoutScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
        layoutScrollFrameRef.current = undefined;
      }
    };
  }, [id, sessionMounted]);
  useEffect(() => {
    if (replacementSessionId && replacementSessionId !== id)
      replaceSession(replacementSessionId);
  }, [id, replaceSession, replacementSessionId]);
  const loadEarlierHistory = useCallback(async () => {
    const currentHistory = history;
    if (
      historyLoading ||
      !currentHistory?.hasOlder ||
      !currentHistory.nextBefore
    )
      return;
    const request = {
      id,
      generation: historyGenerationRef.current,
      controller: new AbortController(),
    };
    historyRequestRef.current = request;
    setHistoryLoading(true);
    setHistoryError(undefined);
    const isCurrentRequest = () =>
      historyRequestRef.current === request &&
      historyGenerationRef.current === request.generation &&
      request.id === id &&
      !request.controller.signal.aborted;
    try {
      const page = await dashboardHttpClient.sessionBefore(
        id,
        currentHistory.nextBefore,
        request.controller.signal,
      );
      if (!isCurrentRequest()) return;
      if (
        page.metadata.id !== id ||
        !page.history ||
        page.history.version !== currentHistory.version ||
        page.history.end !== currentHistory.start ||
        page.history.start >= currentHistory.start ||
        (page.history.hasOlder &&
          (!page.history.nextBefore ||
            page.history.nextBefore === currentHistory.nextBefore))
      )
        throw new Error('Dashboard returned non-contiguous older history.');
      if (!store.prependSessionHistory(page))
        throw new Error('Session changed while loading older history.');
      setHistory(page.history);
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      if (loadError instanceof Error && loadError.name === 'AbortError') return;
      setHistoryError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load older history.',
      );
    } finally {
      if (isCurrentRequest()) {
        historyRequestRef.current = undefined;
        setHistoryLoading(false);
      }
    }
  }, [history, historyLoading, id, store]);
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
  const waitingForInitialHistory =
    data?.entriesComplete === false &&
    (!projection || projection.order.length === 0);
  if (!data || !projection || waitingForInitialHistory) {
    const loadingMetadata = storedMetadata;
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
        <section className="session-page session-page-loading">
          <header className="session-context session-heading">
            <div className="session-context-main">
              <div className="session-identity">
                <div className="session-breadcrumb">
                  <span className="session-workspace">Session</span>
                  <span
                    className="session-breadcrumb-separator"
                    aria-hidden="true"
                  >
                    /
                  </span>
                  <h1>
                    {loadingMetadata
                      ? sessionDisplayTitle(loadingMetadata)
                      : runtime?.session.title || runtime?.session.name || id}
                  </h1>
                </div>
                <span className={`session-status status-${status}`}>
                  <i aria-hidden="true">●</i> {statusLabel}
                </span>
              </div>
            </div>
          </header>
          <div className="transcript session-transcript-loading" role="status">
            <span className="session-loading-indicator" aria-hidden="true" />
            <p>
              {error ??
                (query.error instanceof Error
                  ? query.error.message
                  : 'Loading session…')}
            </p>
            {(error || query.error) && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  hydrationRetryCountRef.current = 0;
                  incompleteRetryCountRef.current = 0;
                  setError(undefined);
                  setIncompleteRetryNonce((current) => current + 1);
                  void requestSessionRefetch();
                }}
              >
                Retry
              </button>
            )}
          </div>
          <PendingInteractions runtime={runtime} />
        </section>
      </div>
    );
  }
  const runtimeError = runtime?.lastError;
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
  const jumpToLatest = () => {
    userScrollIntentRef.current = false;
    stickToBottomRef.current = true;
    setAwayFromLatest(false);
    setTailScrollRequest((current) => current + 1);
    window.scrollTo(0, document.documentElement.scrollHeight);
    window.requestAnimationFrame(() => {
      if (stickToBottomRef.current && !userScrollIntentRef.current)
        window.scrollTo(0, document.documentElement.scrollHeight);
    });
  };
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
        className={`session-page ${inspectorOpen ? 'inspector-open' : ''} ${hasPendingInteraction ? 'has-pending-interaction' : ''}`}
      >
        <header className="session-context session-heading">
          <div className="session-context-main">
            <div className="session-identity">
              <div className="session-breadcrumb">
                <span className="session-workspace">{workspaceName}</span>
                <span
                  className="session-breadcrumb-separator"
                  aria-hidden="true"
                >
                  /
                </span>
                <h1 title={sessionDisplayTitle(data.metadata, data.entries)}>
                  {sessionDisplayTitle(data.metadata, data.entries)}
                </h1>
              </div>
              <span className={`session-status status-${status}`}>
                <i aria-hidden="true">●</i> {statusLabel}
              </span>
            </div>
          </div>
          <div className="session-heading-actions">
            <button
              type="button"
              ref={outlineTriggerRef}
              className="session-icon-button outline-trigger"
              aria-label="Open transcript outline"
              aria-haspopup="dialog"
              onClick={() => setOutlineOpen(true)}
            >
              <span className="session-icon-glyph" aria-hidden="true">
                ≡
              </span>
            </button>
            <button
              type="button"
              className="session-icon-button session-details-trigger"
              aria-label="Details"
              aria-haspopup="dialog"
              aria-expanded={inspectorOpen}
              aria-controls="session-inspector"
              disabled={hasPendingInteraction}
              title={
                hasPendingInteraction
                  ? 'Answer the pending question before opening session details'
                  : 'Session details'
              }
              onClick={() => {
                if (!hasPendingInteraction) setInspectorOpen(true);
              }}
            >
              <span
                className="session-icon-glyph session-more-glyph"
                aria-hidden="true"
              >
                •••
              </span>
              <span className="sr-only">Details</span>
            </button>
          </div>
        </header>
        <SessionInspector
          id={id}
          open={inspectorOpen}
          onClose={closeInspector}
          data={data}
          runtime={runtime}
          runtimeError={runtimeError}
          store={store}
        />
        {history?.hasOlder && (
          <div className="session-history-control" aria-live="polite">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void loadEarlierHistory()}
              disabled={historyLoading}
            >
              {historyLoading
                ? 'Loading earlier history…'
                : historyError
                  ? 'Retry earlier history'
                  : 'Load earlier history'}
            </button>
            {historyError && (
              <span role="alert" className="session-history-error">
                {historyError}
              </span>
            )}
          </div>
        )}
        <Transcript
          key={id}
          projection={projection}
          runtime={runtime}
          tailScrollRequest={tailScrollRequest}
          outlineOpen={outlineOpen}
          onOutlineOpenChange={setOutlineOpen}
        />
        <div ref={controlLayerRef} className="session-control-layer">
          {awayFromLatest && (
            <button
              type="button"
              className="session-icon-button jump-latest"
              onClick={jumpToLatest}
              aria-label="Jump to latest transcript activity"
            >
              ↓
            </button>
          )}
          <ExtensionSurfaceStack runtime={runtime} placement="composer" />
          <Composer
            key={id}
            runtime={runtime}
            runtimes={snapshot.runtimes}
            sessionId={id}
            workspaceId={workspaceId}
            onMessageSubmitted={jumpToLatest}
            onPromptSubmitted={(text) => {
              store.optimisticallyTitleSession(id, text);
            }}
          />
        </div>
        <PendingInteractions runtime={runtime} />
      </section>
    </div>
  );
}

type SessionInspectorData = Pick<SessionApiResponse, 'metadata' | 'entries'>;

export function SessionInspector({
  id,
  open,
  onClose,
  data,
  runtime,
  runtimeError,
  store,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  data: SessionInspectorData;
  runtime: RuntimeSnapshot | undefined;
  runtimeError: string | undefined;
  store: DashboardLiveStore;
}) {
  const title = sessionDisplayTitle(data.metadata, data.entries);
  return (
    <DashboardDialog
      dialogId="session-inspector"
      titleId="session-inspector-title"
      title={title}
      eyebrow="Session details"
      closeLabel="Close session details"
      className="surface-dialog session-inspector"
      isOpen={open}
      onClose={onClose}
    >
      <div className="inspector-body">
        <section
          className="inspector-section"
          aria-labelledby="inspector-rename-heading"
        >
          <h3 id="inspector-rename-heading">Name</h3>
          <SessionRename
            id={id}
            initialName={data.metadata.name}
            store={store}
            onRenamed={(name) => store.updateSessionMetadata(id, { name })}
          />
        </section>
        {runtime && (
          <section
            className="inspector-section"
            aria-labelledby="inspector-controls-heading"
          >
            <h3 id="inspector-controls-heading">Runtime controls</h3>
            <RuntimeActions runtime={runtime} />
          </section>
        )}
        {runtimeError && (
          <div className="error notice inspector-error" role="alert">
            Runtime failure: {runtimeError}
          </div>
        )}
        {!runtime && (
          <p className="muted">
            No active runtime is attached to this session.
          </p>
        )}
      </div>
    </DashboardDialog>
  );
}
