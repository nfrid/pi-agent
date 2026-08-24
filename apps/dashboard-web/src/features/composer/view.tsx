import type { MDXEditorMethods } from '@mdxeditor/editor';
import type { DashboardLiveStore } from '@pi-dashboard/client';
import {
  commandMutationOptions,
  dashboardHttpClient,
  startRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type {
  CheckoutSummary,
  RuntimeSnapshot,
  SessionIndexEntry,
} from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useDashboardNavigate } from '../../routes/navigation';
import { errorMessage } from '../../shared/lib/error-message';
import { ProgressBar } from '../../shared/ui/progress-bar';
import { configuredModelOptions, modelOptionValue } from '../model-option';
import { hasSettledBackground } from '../presentation-status';
import { useImageAttachments } from './attachments';
import { useComposerDraft } from './draft';
import { AgentPicker, ThreadLocationIndicator } from './draft-pickers';
import {
  newQueueId,
  QueuePanel,
  queueCommand,
  shouldShowQueuePanel,
  useComposerQueue,
} from './queue';
import {
  composerIsDisabled,
  composerMode,
  composerSubmissionPolicy,
  contextIndicatorData,
  dormantContextUsage,
  dormantResumeMetadata,
  modelSupportsImages,
  resumeRuntimeRequest,
  runtimeSupportsImages,
  waitForStartedRuntime,
} from './runtime';
import { RuntimeAgentControl } from './runtime-controls';
import { ComposerShell } from './shell';

function ContextIndicator({
  usage,
}: {
  usage: RuntimeSnapshot['contextUsage'];
}) {
  const indicator = contextIndicatorData(usage);
  if (!indicator) return null;
  return (
    <span
      className={`context-indicator context-${indicator.level}`}
      role="img"
      aria-label={`Context window ${indicator.text}`}
    >
      <span className="context-label">ctx</span>
      <ProgressBar
        className="context-meter"
        value={(indicator.percent ?? 0) / 100}
      />
      <strong>
        <span>{indicator.percent ?? '?'}%</span>
        <span className="context-detail">
          {indicator.text.slice(indicator.text.indexOf(' '))}
        </span>
      </strong>
    </span>
  );
}

export function Composer({
  runtime,
  runtimes = runtime ? [runtime] : [],
  session,
  store,
  sessionId,
  projectId,
  checkoutId,
  checkout,
  onMessageSubmitted,
  onPromptSubmitted,
}: {
  runtime: RuntimeSnapshot | undefined;
  runtimes?: readonly RuntimeSnapshot[];
  session?: SessionIndexEntry;
  store?: DashboardLiveStore;
  sessionId: string;
  projectId?: string;
  checkoutId?: string;
  checkout?: CheckoutSummary;
  onMessageSubmitted?: () => void;
  onPromptSubmitted?: (text: string) => void;
}) {
  const go = useDashboardNavigate();
  const { initialDraft, text, updateText, clearDraft } =
    useComposerDraft(sessionId);
  const editorRef = useRef<MDXEditorMethods>(null);
  const mountedRef = useRef(false);
  const [mode, setMode] = useState<'prompt' | 'steer' | 'followUp'>(() =>
    composerMode(runtime),
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string>();
  const [resumePending, setResumePending] = useState(false);
  const dormantImageAttemptRef = useRef(false);
  const commandMutation = useMutation(
    commandMutationOptions(dashboardHttpClient),
  );
  const resumeMutation = useMutation(
    startRuntimeMutationOptions(dashboardHttpClient),
  );
  const composerCommands = runtime?.composerCommands;
  const { queue, setQueue, addOptimistic, rejectOptimistic } =
    useComposerQueue(runtime);
  const settledBackground = hasSettledBackground(runtime);
  const defaultMode = composerMode(runtime);
  const disabled = composerIsDisabled(runtime);
  const submissionDisabled = runtime
    ? disabled
    : !projectId || !checkoutId || resumeMutation.isPending || resumePending;
  const dormantMetadata = dormantResumeMetadata(session, runtimes);
  const [resumeModel, setResumeModel] = useState(dormantMetadata.model);
  const [resumeThinking, setResumeThinking] = useState(
    dormantMetadata.thinking,
  );
  const configuredModels = configuredModelOptions(runtimes);
  const resumeModels =
    resumeModel &&
    !configuredModels.some(
      (model) =>
        modelOptionValue(model.provider, model.model) ===
        modelOptionValue(resumeModel.provider, resumeModel.model),
    )
      ? [resumeModel, ...configuredModels]
      : configuredModels;
  const thinkingLevels = [
    ...new Set([
      ...runtimes.flatMap((candidate) => candidate.thinkingLevels ?? []),
      ...(resumeThinking ? [resumeThinking] : []),
    ]),
  ];
  const attachmentsEnabled = runtime
    ? runtime.liveState !== 'compacting' && runtimeSupportsImages(runtime)
    : modelSupportsImages(resumeModel, runtimes);
  const {
    attachments,
    dragging,
    fileInputRef,
    selectImages,
    removeImage,
    clearAttachments,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onPasteCapture,
  } = useImageAttachments({
    enabled: attachmentsEnabled,
    busy: busy || disabled || resumePending,
    clearOnDisable: !dormantImageAttemptRef.current,
    onError: setError,
  });
  const submissionPolicy = runtime
    ? composerSubmissionPolicy(runtime, mode, attachments.length > 0)
    : { commandType: 'prompt' as const, queues: false };
  const queuesCurrentMessage = submissionPolicy.queues;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    setMode(defaultMode);
  }, [defaultMode]);
  useEffect(() => {
    if (runtime) {
      setResumePending(false);
      return;
    }
    setResumeModel((current) => current ?? dormantMetadata.model);
    setResumeThinking((current) => current ?? dormantMetadata.thinking);
  }, [dormantMetadata.model, dormantMetadata.thinking, runtime]);
  useEffect(() => {
    if (runtime && attachments.length === 0)
      dormantImageAttemptRef.current = false;
  }, [attachments.length, runtime]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedText = text.trim();
    if ((!trimmedText && !attachments.length) || submissionDisabled || busy)
      return;
    if (attachments.length > 0 && !attachmentsEnabled) {
      setError('The selected model does not support image input.');
      return;
    }
    setBusy(true);
    setError(undefined);
    if (!runtime) {
      const hasImages = attachments.length > 0;
      const request = resumeRuntimeRequest(
        projectId,
        checkoutId,
        sessionId,
        hasImages ? undefined : trimmedText,
        resumeModel
          ? {
              provider: resumeModel.provider,
              model: resumeModel.model,
              ...(resumeThinking ? { thinking: resumeThinking } : {}),
            }
          : undefined,
      );
      if (!request) {
        setResumeError('This session has no project checkout association.');
        setBusy(false);
        return;
      }
      setResumeError(undefined);
      dormantImageAttemptRef.current = hasImages;
      setResumePending(true);
      try {
        // Text resumes use the start mutation's exact-once initialPrompt path.
        const result = await resumeMutation.mutateAsync(request);
        if (!mountedRef.current) return;
        if (hasImages) {
          if (!store)
            throw new Error('The dormant session store is unavailable.');
          const started = await waitForStartedRuntime(
            store,
            result.result.runtimeId,
          );
          if (!runtimeSupportsImages(started))
            throw new Error(
              'The resumed runtime does not support image input.',
            );
          await dashboardHttpClient.sendCommandWithImages(
            result.result.runtimeId,
            { type: 'prompt', text: trimmedText },
            attachments.map((attachment) => attachment.file),
          );
          clearAttachments();
        }
        clearDraft();
        editorRef.current?.setMarkdown('');
        onPromptSubmitted?.(trimmedText);
      } catch (cause) {
        if (mountedRef.current) {
          setResumePending(false);
          setResumeError(errorMessage(cause));
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
      return;
    }
    const commandType = submissionPolicy.commandType;
    const command = {
      type: commandType,
      text: trimmedText,
    };
    if (commandType === 'prompt') onPromptSubmitted?.(trimmedText);
    try {
      if (queuesCurrentMessage) {
        const queueId = newQueueId();
        const queuedItem = {
          id: queueId,
          mode: mode === 'prompt' ? ('followUp' as const) : mode,
          text: trimmedText,
        };
        // Install the row before waiting for the HTTP acknowledgement. The
        // runtime event and command response are independent streams and may
        // arrive in either order; the hook reconciles the optimistic row with
        // the authoritative server queue when the event arrives.
        addOptimistic(queuedItem);
        try {
          await commandMutation.mutateAsync({
            runtimeId: runtime.runtimeId,
            command: queueCommand(
              'queue.add',
              queueId,
              queuedItem.mode,
              trimmedText,
            ),
          });
        } catch (cause) {
          if (mountedRef.current) rejectOptimistic(queueId);
          throw cause;
        }
      } else if (attachments.length)
        await dashboardHttpClient.sendCommandWithImages(
          runtime.runtimeId,
          command,
          attachments.map((attachment) => attachment.file),
        );
      else
        await commandMutation.mutateAsync({
          runtimeId: runtime.runtimeId,
          command,
        });
      if (!mountedRef.current) return;
      clearAttachments();
      clearDraft();
      editorRef.current?.setMarkdown('');
      onMessageSubmitted?.();
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };
  if (runtime?.online === false)
    return (
      <div className="composer disabled">
        <p>Runtime offline; controls are unavailable.</p>
        <button
          type="button"
          onClick={() =>
            go(`/runtimes/${encodeURIComponent(runtime.runtimeId)}`)
          }
        >
          View diagnostics
        </button>
      </div>
    );
  const abortTurn = async () => {
    if (!runtime || busy || commandMutation.isPending) return;
    setError(undefined);
    try {
      await commandMutation.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: { type: 'abort' },
      });
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause));
    }
  };
  return (
    <>
      {runtime &&
        shouldShowQueuePanel(
          runtime.liveState,
          queue.length,
          settledBackground,
        ) && (
          <QueuePanel
            runtimeId={runtime.runtimeId}
            items={queue}
            onItemsChange={setQueue}
          />
        )}
      <ComposerShell
        ariaLabel="Send a message"
        onSubmit={(event) => void submit(event)}
        dragging={dragging}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        attachmentsEnabled={attachmentsEnabled}
        attachmentsBusy={
          runtime
            ? disabled || busy
            : submissionDisabled || busy || resumePending
        }
        fileInputRef={fileInputRef}
        attachments={attachments}
        onSelectImages={selectImages}
        onRemoveImage={removeImage}
        onPasteCapture={onPasteCapture}
        editorRef={editorRef}
        initialMarkdown={initialDraft}
        commands={
          runtime?.liveState === 'working' && !settledBackground
            ? composerCommands?.filter(
                (command) => command.source !== 'builtin',
              )
            : composerCommands
        }
        onChange={updateText}
        placeholder={
          runtime && disabled ? 'Agent is waiting for input' : 'Message Pi…'
        }
        readOnly={(runtime ? disabled : submissionDisabled) || busy}
        submissionDisabled={submissionDisabled || busy}
        sendDisabled={
          submissionDisabled || busy || (!text.trim() && !attachments.length)
        }
        sendAriaLabel={
          runtime
            ? queuesCurrentMessage
              ? 'Queue message'
              : 'Send'
            : 'Send message'
        }
        sendSrOnly={
          runtime ? (queuesCurrentMessage ? 'Queue' : 'Send') : undefined
        }
        actionExtras={
          runtime?.liveState === 'working' && !settledBackground ? (
            <AriaButton
              type="button"
              className="composer-abort"
              isDisabled={busy || commandMutation.isPending}
              onPress={() => void abortTurn()}
              aria-label="Abort turn"
            >
              <span aria-hidden="true">■</span>
            </AriaButton>
          ) : undefined
        }
        mode={
          <>
            {runtime?.liveState === 'working' && !settledBackground && (
              <AriaButton
                type="button"
                aria-label="Steer current work instead of following up later"
                aria-pressed={mode === 'steer'}
                className={mode === 'steer' ? 'selected' : ''}
                onPress={() =>
                  setMode((current) =>
                    current === 'steer' ? 'followUp' : 'steer',
                  )
                }
              >
                {mode === 'steer' ? 'Steer' : 'Later'}
              </AriaButton>
            )}
            {checkout ? (
              <ThreadLocationIndicator checkout={checkout} />
            ) : (
              (!runtime ||
                runtime.liveState === 'idle' ||
                settledBackground) && <span>Prompt</span>
            )}
            {runtime?.liveState === 'waiting' && <span>Answer above</span>}
            <ContextIndicator
              usage={
                runtime?.contextUsage ??
                dormantContextUsage(session, resumeModel, runtimes)
              }
            />
          </>
        }
        controls={
          runtime ? (
            <RuntimeAgentControl runtime={runtime} runtimes={runtimes} />
          ) : (
            <AgentPicker
              model={
                resumeModel
                  ? {
                      provider: resumeModel.provider,
                      model: resumeModel.model,
                      ...(resumeThinking ? { thinking: resumeThinking } : {}),
                    }
                  : undefined
              }
              models={resumeModels}
              levels={thinkingLevels}
              disabled={submissionDisabled || busy}
              onModelChange={setResumeModel}
              onThinkingChange={setResumeThinking}
            />
          )
        }
        footer={
          !runtime && (!projectId || !checkoutId) ? (
            <p className="error composer-error" role="alert">
              This session has no project checkout association.
            </p>
          ) : !runtime && resumeError ? (
            <p className="error composer-error" role="alert">
              {resumeError}
            </p>
          ) : error ? (
            <p className="error composer-error" role="alert">
              {error}
            </p>
          ) : resumePending ? (
            <output>Resuming…</output>
          ) : undefined
        }
      />
    </>
  );
}
