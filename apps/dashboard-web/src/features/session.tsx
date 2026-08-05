import {
  type DashboardLiveStore,
  dashboardHttpClient,
  selectSessionChange,
  selectSessionReplacement,
  sessionQueryOptions,
  useDashboardStore,
} from '@pi-dashboard/client';
import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  SessionApiResponse,
} from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
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
import { AgentThreadNav, workspaceNameForSession } from './agent-thread-nav';
import { ExtensionSurfaceStack } from './extension-surfaces';
import { useOverlayPresence } from './overlay-presence';
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
  sessionId: string;
};

export function SessionView({
  id,
  snapshot,
  store,
  Composer,
}: {
  id: string;
  snapshot: BrowserSnapshot;
  store: DashboardLiveStore;
  Composer: ComponentType<ComposerProps>;
}) {
  const navigate = useNavigate();
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
  const sessionChange = useDashboardStore(store, selectSessionChange(id));
  const runtime = snapshot.runtimes.find((item) => item.session.id === id);
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
  const closeInspector = useCallback(() => setInspectorOpen(false), []);
  const scrolledSessionRef = useRef<string | undefined>(undefined);
  const stickToBottomRef = useRef(true);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const outlineWasOpenRef = useRef(false);
  useEffect(() => {
    if (!id) return;
    setError(undefined);
  }, [id]);
  useEffect(() => {
    if (!query.data) return;
    if (query.data.metadata.id !== id) {
      void navigate({
        to: `/sessions/${encodeURIComponent(query.data.metadata.id)}`,
      });
      return;
    }
    if (store.hydrateSession(query.data)) {
      setError(undefined);
      return;
    }
    setError('Session changed while loading; retrying…');
    const retry = window.setTimeout(() => void query.refetch(), 25);
    return () => window.clearTimeout(retry);
  }, [id, navigate, query.data, query.refetch, store]);
  useEffect(() => {
    if (resyncNonce > 0) void query.refetch();
  }, [query.refetch, resyncNonce]);
  useEffect(() => {
    if (outlineOpen) outlineWasOpenRef.current = true;
    else if (outlineWasOpenRef.current) {
      outlineWasOpenRef.current = false;
      outlineTriggerRef.current?.focus();
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
    void id;
    stickToBottomRef.current = true;
    setAwayFromLatest(false);
    const update = () => {
      const nearLatest = isNearPageBottom(
        document.documentElement.scrollHeight,
        window.scrollY,
        window.innerHeight,
      );
      stickToBottomRef.current = nearLatest;
      setAwayFromLatest(
        shouldShowJumpToLatest(
          document.documentElement.scrollHeight,
          window.scrollY,
          window.innerHeight,
        ),
      );
    };
    window.addEventListener('scroll', update, { passive: true });
    update();
    return () => window.removeEventListener('scroll', update);
  }, [id]);
  useLayoutEffect(() => {
    if (!data || !projection) return;
    const enteringSession = scrolledSessionRef.current !== id;
    if (!enteringSession && !stickToBottomRef.current) return;
    scrolledSessionRef.current = id;
    const frame = window.requestAnimationFrame(() => {
      // Virtualization can increase the document height before this frame and
      // make the scroll listener clear stickiness. Entering a session must
      // still establish the initial tail position.
      if (!enteringSession && !stickToBottomRef.current) return;
      window.scrollTo(0, document.documentElement.scrollHeight);
      stickToBottomRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data, projection, id]);
  useEffect(() => {
    if (replacementSessionId && replacementSessionId !== id) {
      void navigate({
        to: `/sessions/${encodeURIComponent(replacementSessionId)}`,
      });
      return;
    }
    if (data && sessionChange > 0)
      stickToBottomRef.current = isNearPageBottom(
        document.documentElement.scrollHeight,
        window.scrollY,
        window.innerHeight,
      );
  }, [data, id, navigate, replacementSessionId, sessionChange]);
  if (!data || !projection)
    return (
      <section>
        <p>{error ?? 'Loading session…'}</p>
      </section>
    );
  const runtimeError = runtime?.lastError;
  const hasPendingInteraction = Boolean(runtime?.pendingInteractions.length);
  const workspaceName = workspaceNameForSession(
    snapshot,
    data.metadata,
    runtime,
  );
  const status = runtime
    ? runtime.online === false
      ? 'offline'
      : runtime.liveState === 'idle'
        ? 'ready'
        : runtime.liveState
    : 'dormant';
  const jumpToLatest = () => {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'smooth',
    });
    stickToBottomRef.current = true;
    setAwayFromLatest(false);
  };
  return (
    <div className="session-layout">
      <AgentThreadNav
        snapshot={snapshot}
        mode="session"
        currentSessionId={id}
        open={agentNavOpen}
        onOpenChange={setAgentNavOpen}
      />
      <section
        className={`session-page ${inspectorOpen ? 'inspector-open' : ''} ${hasPendingInteraction ? 'has-pending-interaction' : ''}`}
      >
        <header className="session-context session-heading">
          <div className="session-context-main">
            <div className="session-identity">
              <div className="session-breadcrumb">
                <span>{workspaceName}</span>
                <span aria-hidden="true"> / </span>
                <h1 title={sessionDisplayTitle(data.metadata, data.entries)}>
                  {sessionDisplayTitle(data.metadata, data.entries)}
                </h1>
              </div>
              <span className={`session-status status-${status}`}>
                <i aria-hidden="true">●</i> {status}
              </span>
            </div>
          </div>
          <div className="session-heading-actions">
            {awayFromLatest && (
              <button
                type="button"
                className="session-icon-button jump-latest"
                onClick={jumpToLatest}
                aria-label="Jump to latest transcript activity"
                title="Jump to latest"
              >
                ↓
              </button>
            )}
            <button
              type="button"
              ref={outlineTriggerRef}
              className="session-icon-button outline-trigger"
              aria-label="Open transcript outline"
              aria-haspopup="dialog"
              onClick={() => setOutlineOpen(true)}
            >
              ≡
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
              ⋯<span className="sr-only">Details</span>
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
        <Transcript
          projection={projection}
          runtime={runtime}
          outlineOpen={outlineOpen}
          onOutlineOpenChange={setOutlineOpen}
        />
        <div className="session-control-layer">
          <ExtensionSurfaceStack runtime={runtime} placement="composer" />
          <Composer runtime={runtime} sessionId={id} />
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
  const panelRef = useRef<HTMLElement>(null);
  const triggerFocusRef = useRef<HTMLElement | null>(null);
  const { present, exiting } = useOverlayPresence(open);
  useEffect(() => {
    if (!open) return;
    triggerFocusRef.current = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled)',
      );
      (first ?? panelRef.current)?.focus();
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled)',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panelRef.current.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      triggerFocusRef.current?.focus();
      triggerFocusRef.current = null;
    };
  }, [onClose, open]);
  if (!present) return null;
  const title = sessionDisplayTitle(data.metadata, data.entries);
  return (
    <div
      className={`session-inspector-layer${exiting ? ' is-exiting' : ''}`}
      aria-hidden={exiting || undefined}
    >
      <button
        type="button"
        className={`session-inspector-backdrop${exiting ? ' is-exiting' : ''}`}
        aria-label="Close session details"
        onClick={onClose}
      />
      <section
        ref={panelRef}
        id="session-inspector"
        className={`session-inspector${exiting ? ' is-exiting' : ''}`}
        role="dialog"
        aria-hidden={exiting || undefined}
        aria-modal="true"
        aria-labelledby="session-inspector-title"
        tabIndex={-1}
      >
        <header className="inspector-header">
          <div>
            <p className="inspector-kicker">Session details</p>
            <h2 id="session-inspector-title">{title}</h2>
          </div>
          <button
            type="button"
            className="inspector-close"
            onClick={onClose}
            aria-label="Close session details"
          >
            ×
          </button>
        </header>
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
      </section>
    </div>
  );
}
