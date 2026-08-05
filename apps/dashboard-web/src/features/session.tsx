import {
  actionMutationOptions,
  commandMutationOptions,
  type DashboardLiveStore,
  dashboardHttpClient,
  interactionAnswerMutationOptions,
  interactionCancelMutationOptions,
  invalidateDashboardQueries,
  renameSessionMutationOptions,
  restartRuntimeMutationOptions,
  selectSessionChange,
  selectSessionReplacement,
  sessionQueryOptions,
  stopRuntimeMutationOptions,
  useDashboardStore,
} from '@pi-dashboard/client';
import { selectLegacyTranscriptEntries } from '@pi-dashboard/domain';
import type {
  BrowserSnapshot,
  InteractionChoice,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type ComponentType,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { isNearPageBottom, sessionDisplayTitle } from '../app-helpers';
import { Transcript } from '../entities/transcript';
import { Markdown } from '../Markdown';
import {
  renderDashboardContribution,
  resolveDashboardRenderer,
} from '../renderer-registry';
import { ExtensionSurfaceStack } from './extension-surfaces';

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
            {runtime?.model &&
              ` · ${runtime.model.provider}/${runtime.model.model}${runtime.model.thinking ? ` · ${runtime.model.thinking}` : ''}`}
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
        <InteractionCard
          key={interaction.id}
          interaction={interaction}
          runtime={runtime}
        />
      ))}
      <ExtensionSurfaceStack runtime={runtime} />
      <Transcript
        entries={selectLegacyTranscriptEntries(projection)}
        runtime={runtime}
      />
      <ExtensionSurfaceStack runtime={runtime} placement="composer" />
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
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [restarting, setRestarting] = useState(false);
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const action = useMutation(actionMutationOptions(dashboardHttpClient));
  const stop = useMutation(stopRuntimeMutationOptions(dashboardHttpClient));
  const restart = useMutation(
    restartRuntimeMutationOptions(dashboardHttpClient),
  );
  const busy =
    restarting ||
    command.isPending ||
    action.isPending ||
    stop.isPending ||
    restart.isPending;
  const compactSupported = Boolean(
    runtime.capabilities?.manifests.some((manifest) =>
      manifest.actions.some((candidate) => candidate.id === 'session.compact'),
    ),
  );
  const run = async (operation: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const onlineOnly = busy || runtime.online === false;
  return (
    <div className="actions">
      <button
        type="button"
        disabled={onlineOnly}
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
      {compactSupported && (
        <button
          type="button"
          disabled={onlineOnly}
          onClick={() =>
            void run(() =>
              action.mutateAsync({
                runtimeId: runtime.runtimeId,
                actionId: 'session.compact',
                input: {},
              }),
            )
          }
        >
          Compact
        </button>
      )}
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() =>
          void run(() =>
            stop.mutateAsync({ runtimeId: runtime.runtimeId, force: false }),
          )
        }
      >
        Stop
      </button>
      {runtime.ownership === 'managed' && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setRestarting(true);
                try {
                  const result = (await restart.mutateAsync(
                    runtime.runtimeId,
                  )) as { result?: { runtimeId?: unknown } };
                  const nextId = result.result?.runtimeId;
                  if (typeof nextId !== 'string')
                    throw new Error('Restart did not return a runtime ID.');
                  await navigate({ to: `/runtimes/${nextId}` });
                } finally {
                  setRestarting(false);
                }
              })
            }
          >
            {restarting ? 'Restarting…' : 'Restart'}
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() =>
              void run(() =>
                stop.mutateAsync({
                  runtimeId: runtime.runtimeId,
                  force: true,
                }),
              )
            }
          >
            Force stop
          </button>
        </>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export type InteractionKeyAction =
  | { type: 'move'; index: number }
  | { type: 'submit'; index: number }
  | { type: 'cancel' };

/** The focused interaction's small keyboard contract, kept pure for testing. */
export function selectedInteractionPreview(
  choices: readonly InteractionChoice[],
  selected: number,
): string | undefined {
  return choices.filter((choice) => !choice.custom)[selected]?.preview;
}

export function interactionKeyAction(
  key: string,
  selected: number,
  choiceCount: number,
  textEntryFocused = false,
): InteractionKeyAction | undefined {
  if (textEntryFocused) return undefined;
  if (key === 'Escape') return { type: 'cancel' };
  if (choiceCount <= 0) return undefined;
  const current = Math.max(0, Math.min(selected, choiceCount - 1));
  if (key === 'ArrowUp')
    return { type: 'move', index: Math.max(0, current - 1) };
  if (key === 'ArrowDown')
    return { type: 'move', index: Math.min(choiceCount - 1, current + 1) };
  if (key === 'Enter') return { type: 'submit', index: current };
  if (/^[0-9]$/.test(key)) {
    const number = key === '0' ? 10 : Number(key);
    if (number >= 1 && number <= choiceCount)
      return { type: 'move', index: number - 1 };
  }
  return undefined;
}

function blocksInteractionShortcut(
  target: EventTarget | null,
  key: string,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable ||
    target.closest('a[href], [role="link"]')
  )
    return true;
  return (
    (key === 'Enter' || key === ' ') &&
    Boolean(target.closest('button, [role="button"]'))
  );
}

function InteractionCard({
  interaction,
  runtime,
}: {
  interaction: RuntimeSnapshot['pendingInteractions'][number];
  runtime: RuntimeSnapshot;
}) {
  const answerActionId = interaction.answerActionId ?? 'ask-user.answer';
  const cancelActionId = interaction.cancelActionId ?? 'ask-user.cancel';
  const supportsSemanticAnswer = Boolean(
    interaction.answerActionId &&
      runtime.capabilities?.manifests.some((manifest) =>
        manifest.actions.some((action) => action.id === answerActionId),
      ),
  );
  const supportsSemanticCancel = Boolean(
    interaction.cancelActionId &&
      runtime.capabilities?.manifests.some((manifest) =>
        manifest.actions.some((action) => action.id === cancelActionId),
      ),
  );
  const legacyInteraction = runtime.capabilities === undefined;
  const canAnswer = legacyInteraction || supportsSemanticAnswer;
  const canCancel = legacyInteraction || supportsSemanticCancel;
  const selectableChoices = interaction.choices.filter(
    (choice) => !choice.custom,
  );
  const [answer, setAnswer] = useState('');
  const [selectedChoice, setSelectedChoice] = useState(0);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const interactionRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const choiceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const answerMutation = useMutation(
    interactionAnswerMutationOptions(dashboardHttpClient),
  );
  const cancelMutation = useMutation(
    interactionCancelMutationOptions(dashboardHttpClient),
  );
  const busy = answerMutation.isPending || cancelMutation.isPending;
  const knownRenderer = resolveDashboardRenderer(interaction.rendererId);
  const canRenderInteraction =
    !interaction.rendererId || Boolean(knownRenderer);
  const selectedPreview = selectedInteractionPreview(
    interaction.choices,
    selectedChoice,
  );

  useEffect(() => {
    setSelectedChoice((current) =>
      Math.min(current, Math.max(0, selectableChoices.length - 1)),
    );
  }, [selectableChoices.length]);
  useEffect(() => {
    if (!canRenderInteraction || !canAnswer) return;
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement
    )
      return;
    if (selectableChoices.length > 0) interactionRef.current?.focus();
    else if (interaction.allowCustom) answerRef.current?.focus();
  }, [
    canAnswer,
    canRenderInteraction,
    interaction.allowCustom,
    selectableChoices.length,
  ]);

  const submit = async (value: string) => {
    if (busy || !canAnswer || !value.trim()) return;
    setError(undefined);
    try {
      if (supportsSemanticAnswer)
        await dashboardHttpClient.invokeAction(
          runtime.runtimeId,
          answerActionId,
          { interactionId: interaction.id, answer: value },
        );
      else if (legacyInteraction)
        await answerMutation.mutateAsync({ id: interaction.id, answer: value });
      else throw new Error('Answer action is not supported by this runtime.');
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const cancel = async () => {
    if (busy || !canCancel) return;
    setError(undefined);
    try {
      if (supportsSemanticCancel)
        await dashboardHttpClient.invokeAction(
          runtime.runtimeId,
          cancelActionId,
          { interactionId: interaction.id },
        );
      else if (legacyInteraction)
        await cancelMutation.mutateAsync(interaction.id);
      else throw new Error('Cancel action is not supported by this runtime.');
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const selectChoice = (index: number) => {
    setSelectedChoice(index);
    choiceRefs.current[index]?.focus();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Form controls and preview links own their keys. Choice buttons retain
    // native Enter/Space activation while arrows, digits, and Escape remain
    // available for the interaction's keyboard contract.
    if (blocksInteractionShortcut(event.target, event.key) || busy) return;
    const action = interactionKeyAction(
      event.key,
      selectedChoice,
      selectableChoices.length,
    );
    if (!action) return;
    if (action.type === 'cancel') {
      if (!canCancel) return;
      event.preventDefault();
      void cancel();
      return;
    }
    if (!canAnswer) return;
    event.preventDefault();
    if (action.type === 'move') {
      selectChoice(action.index);
      return;
    }
    const choice = selectableChoices[action.index];
    if (choice) void submit(choice.value);
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
      aria-keyshortcuts="ArrowUp ArrowDown Enter Escape"
      tabIndex={selectableChoices.length > 0 ? 0 : undefined}
      ref={interactionRef}
      onKeyDown={handleKeyDown}
    >
      <p className="eyebrow">Waiting for input</p>
      <h2 id={`interaction-${interaction.id}`}>{interaction.question}</h2>
      {error && (
        <p className="error" role="alert">
          Interaction failed: {error}
        </p>
      )}
      {interaction.rendererId && !knownRenderer && (
        <div className="contribution-fallback-view">
          {renderDashboardContribution(
            interaction.rendererId,
            interaction.viewModel ?? interaction,
          )}
        </div>
      )}
      {canRenderInteraction && selectableChoices.length > 0 && (
        <div
          className={`interaction-choice-layout${selectedPreview ? ' has-preview' : ''}`}
        >
          <fieldset className="choices">
            <legend className="sr-only">Choices</legend>
            {selectableChoices.map((choice, index) => (
              <AriaButton
                type="button"
                isDisabled={busy || !canAnswer}
                key={choice.value}
                ref={(element) => {
                  choiceRefs.current[index] = element;
                }}
                data-selected={selectedChoice === index ? 'true' : undefined}
                onFocus={() => setSelectedChoice(index)}
                onPress={() => {
                  setSelectedChoice(index);
                  void submit(choice.value);
                }}
              >
                <span className="choice-number">{index + 1}.</span>
                <span className="choice-label">{choice.label}</span>
                {choice.description && <small>{choice.description}</small>}
              </AriaButton>
            ))}
          </fieldset>
          {selectedPreview && (
            <aside
              className="interaction-preview"
              aria-label="Selected choice preview"
              aria-live="polite"
            >
              <p className="eyebrow">Preview</p>
              <Markdown>{selectedPreview}</Markdown>
            </aside>
          )}
        </div>
      )}
      {canRenderInteraction && canAnswer && interaction.allowCustom && (
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
            ref={answerRef}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={interaction.customLabel ?? 'Type an answer'}
          />
          <AriaButton isDisabled={busy || !canAnswer} type="submit">
            Answer
          </AriaButton>
        </form>
      )}
      {canRenderInteraction && canCancel && (
        <AriaButton
          type="button"
          isDisabled={busy || !canCancel}
          className="link-button"
          onPress={() => void cancel()}
        >
          Cancel
        </AriaButton>
      )}
    </div>
  );
}

export { Back };
