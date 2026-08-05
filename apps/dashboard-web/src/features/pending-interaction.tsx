import {
  dashboardHttpClient,
  interactionAnswerMutationOptions,
  interactionCancelMutationOptions,
} from '@pi-dashboard/client';
import type {
  InteractionChoice,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Markdown } from '../Markdown';
import {
  renderDashboardContribution,
  resolveDashboardRenderer,
} from '../renderer-registry';

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

export function PendingInteractions({
  runtime,
}: {
  runtime: RuntimeSnapshot | undefined;
}) {
  const dockRef = useRef<HTMLElement>(null);
  const interactionKey = runtime?.pendingInteractions
    .map((interaction) => interaction.id)
    .join('\u0000');
  useEffect(() => {
    if (!interactionKey) return;
    const frame = window.requestAnimationFrame(() => {
      dockRef.current
        ?.querySelector<HTMLElement>(
          '.interaction[tabindex="0"], input:not(:disabled), button:not(:disabled)',
        )
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [interactionKey]);
  if (!runtime || runtime.pendingInteractions.length === 0) return null;
  return (
    <aside
      ref={dockRef}
      className="interaction-dock"
      role="dialog"
      aria-modal="true"
      aria-label="Pending questions"
      aria-live="assertive"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || !dockRef.current) return;
        const focusable = Array.from(
          dockRef.current.querySelectorAll<HTMLElement>(
            '.interaction[tabindex="0"], input:not(:disabled), button:not(:disabled), a[href]',
          ),
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) {
          event.preventDefault();
          dockRef.current.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {runtime.pendingInteractions.map((interaction) => (
        <InteractionCard
          key={interaction.id}
          interaction={interaction}
          runtime={runtime}
        />
      ))}
    </aside>
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
  const interactionRef = useRef<HTMLFieldSetElement>(null);
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
  const handleKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
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
    <fieldset
      className="interaction"
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
    </fieldset>
  );
}
