import {
  type DashboardLiveStore,
  dashboardHttpClient,
  selectSessionChange,
  selectSessionReplacement,
  sessionQueryOptions,
  useDashboardStore,
} from '@pi-dashboard/client';
import type { BrowserSnapshot, RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type ComponentType,
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
import { ExtensionSurfaceStack } from './extension-surfaces';
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

function Back() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="back"
      onClick={() => void navigate({ to: '/' })}
    >
      ← Dashboard
    </button>
  );
}

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
  const scrolledSessionRef = useRef<string | undefined>(undefined);
  const stickToBottomRef = useRef(true);
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
        <Back />
        <p>{error ?? 'Loading session…'}</p>
      </section>
    );
  const runtimeError = runtime?.lastError;
  const jumpToLatest = () => {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'smooth',
    });
    stickToBottomRef.current = true;
    setAwayFromLatest(false);
  };
  return (
    <section className="session-page">
      <div className="session-context session-heading">
        <div className="session-context-main">
          <Back />
          <div className="session-identity">
            <h1 title={sessionDisplayTitle(data.metadata, data.entries)}>
              {sessionDisplayTitle(data.metadata, data.entries)}
            </h1>
            <p className="muted">
              {data.metadata.cwd} ·{' '}
              {runtime
                ? runtime.online === false
                  ? 'offline'
                  : runtime.liveState
                : 'dormant'}
              {runtime?.model &&
                ` · ${runtime.model.provider}/${runtime.model.model}${runtime.model.thinking ? ` · ${runtime.model.thinking}` : ''}`}
            </p>
          </div>
        </div>
        <div className="session-heading-actions">
          {awayFromLatest && (
            <button
              type="button"
              className="jump-latest"
              onClick={jumpToLatest}
              aria-label="Jump to latest transcript activity"
            >
              ↓ Latest
            </button>
          )}
          <SessionRename
            id={id}
            initialName={data.metadata.name}
            store={store}
            onRenamed={(name) => store.updateSessionMetadata(id, { name })}
          />
          {runtime && (
            <details className="session-controls">
              <summary>Runtime controls</summary>
              <RuntimeActions runtime={runtime} />
            </details>
          )}
        </div>
      </div>
      {runtimeError && (
        <div className="error notice" role="alert">
          Runtime failure: {runtimeError}
        </div>
      )}
      <Transcript projection={projection} runtime={runtime} />
      <div className="session-control-layer">
        <ExtensionSurfaceStack runtime={runtime} />
        <ExtensionSurfaceStack runtime={runtime} placement="composer" />
        <Composer runtime={runtime} sessionId={id} />
      </div>
      <PendingInteractions runtime={runtime} />
    </section>
  );
}

export { Back };
