import {
  commandMutationOptions,
  type DashboardLiveStore,
  dashboardHttpClient,
  interactionAnswerMutationOptions,
  interactionCancelMutationOptions,
  invalidateDashboardQueries,
  renameSessionMutationOptions,
  selectSessionChange,
  selectSessionReplacement,
  sessionQueryOptions,
  stopRuntimeMutationOptions,
  useDashboardStore,
} from '@pi-dashboard/client';
import { selectLegacyTranscriptEntries } from '@pi-dashboard/domain';
import type { BrowserSnapshot, RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type ComponentType,
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { isNearPageBottom, sessionDisplayTitle } from '../app-helpers';
import { Transcript } from '../entities/transcript';

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
    const update = () => {
      stickToBottomRef.current = isNearPageBottom(
        document.documentElement.scrollHeight,
        window.scrollY,
        window.innerHeight,
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
      if (!stickToBottomRef.current) return;
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
  return (
    <section className="session-page">
      <Back />
      <div className="session-heading">
        <div>
          <p className="eyebrow">Session</p>
          <h1>{sessionDisplayTitle(data.metadata, data.entries)}</h1>
          <p className="muted">
            {data.metadata.cwd} ·{' '}
            {runtime
              ? runtime.online === false
                ? 'offline'
                : runtime.liveState
              : 'dormant'}
          </p>
        </div>
        <div className="session-heading-actions">
          <SessionRename
            id={id}
            initialName={data.metadata.name}
            store={store}
            onRenamed={(name) => store.updateSessionMetadata(id, { name })}
          />
          {runtime && <RuntimeActions runtime={runtime} />}
        </div>
      </div>
      {runtimeError && (
        <div className="error notice" role="alert">
          Runtime failure: {runtimeError}
        </div>
      )}
      {runtime?.pendingInteractions.map((interaction) => (
        <InteractionCard key={interaction.id} interaction={interaction} />
      ))}
      <Transcript entries={selectLegacyTranscriptEntries(projection)} />
      <Composer runtime={runtime} sessionId={id} />
    </section>
  );
}

function SessionRename({
  id,
  initialName,
  store,
  onRenamed,
}: {
  id: string;
  initialName?: string;
  store: DashboardLiveStore;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [error, setError] = useState<string>();
  const mutation = useMutation(
    renameSessionMutationOptions(dashboardHttpClient),
  );
  const queryClient = useQueryClient();
  const busy = mutation.isPending;
  useEffect(() => setName(initialName ?? ''), [initialName]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value || busy) return;
    setError(undefined);
    const requestGeneration = store.getGeneration();
    try {
      const result = await mutation.mutateAsync({ id, name: value });
      store.applyMutationResult(result, requestGeneration);
      onRenamed(value);
      await invalidateDashboardQueries(queryClient);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <form className="session-rename" onSubmit={(event) => void submit(event)}>
      <label htmlFor="session-name">Name</label>
      <input
        id="session-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Session name"
        maxLength={512}
        disabled={busy}
      />
      <button type="submit" disabled={busy || !name.trim()}>
        {busy ? 'Saving…' : 'Rename'}
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

function RuntimeActions({ runtime }: { runtime: RuntimeSnapshot }) {
  const [error, setError] = useState<string>();
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const stop = useMutation(stopRuntimeMutationOptions(dashboardHttpClient));
  const busy = command.isPending || stop.isPending;
  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const disabled = busy || runtime.online === false;
  return (
    <div className="actions">
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          void run(() =>
            command.mutateAsync({
              runtimeId: runtime.runtimeId,
              command: { type: 'abort' },
            }),
          )
        }
      >
        Abort
      </button>
      <button
        type="button"
        className="danger"
        disabled={disabled}
        onClick={() => void run(() => stop.mutateAsync(runtime.runtimeId))}
      >
        Stop
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function InteractionCard({
  interaction,
}: {
  interaction: RuntimeSnapshot['pendingInteractions'][number];
}) {
  const [answer, setAnswer] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const answerMutation = useMutation(
    interactionAnswerMutationOptions(dashboardHttpClient),
  );
  const cancelMutation = useMutation(
    interactionCancelMutationOptions(dashboardHttpClient),
  );
  const busy = answerMutation.isPending || cancelMutation.isPending;
  const submit = async (value: string) => {
    setError(undefined);
    try {
      await answerMutation.mutateAsync({ id: interaction.id, answer: value });
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const cancel = async () => {
    setError(undefined);
    try {
      await cancelMutation.mutateAsync(interaction.id);
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  if (sent)
    return (
      <div className="notice">
        Answered from this dashboard. The other Pi surface will close its
        question.
      </div>
    );
  return (
    <div
      className="interaction"
      role="dialog"
      aria-labelledby={`interaction-${interaction.id}`}
    >
      <p className="eyebrow">Waiting for input</p>
      <h2 id={`interaction-${interaction.id}`}>{interaction.question}</h2>
      {error && (
        <p className="error" role="alert">
          Interaction failed: {error}
        </p>
      )}
      <div className="choices">
        {interaction.choices
          .filter((choice) => !choice.custom)
          .map((choice) => (
            <AriaButton
              type="button"
              isDisabled={busy}
              key={choice.value}
              onPress={() => void submit(choice.value)}
            >
              {choice.label}
              <small>{choice.description}</small>
            </AriaButton>
          ))}
      </div>
      {interaction.allowCustom && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (answer.trim()) void submit(answer.trim());
          }}
        >
          <label className="sr-only" htmlFor={`answer-${interaction.id}`}>
            Answer
          </label>
          <input
            id={`answer-${interaction.id}`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={interaction.customLabel ?? 'Type an answer'}
          />
          <AriaButton isDisabled={busy} type="submit">
            Answer
          </AriaButton>
        </form>
      )}
      <AriaButton
        type="button"
        isDisabled={busy}
        className="link-button"
        onPress={() => void cancel()}
      >
        Cancel
      </AriaButton>
    </div>
  );
}

export { Back };
