import type { MDXEditorMethods } from '@mdxeditor/editor';
import type { DashboardLiveStore } from '@pi-dashboard/client';
import {
  commandMutationOptions,
  dashboardHttpClient,
  startRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type {
  RuntimeSnapshot,
  SessionIndexEntry,
} from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useDashboardNavigate } from '../../routes/navigation';
import { errorMessage } from '../../shared/lib/error-message';
import { ProgressBar } from '../../shared/ui/progress-bar';

import { hasSettledBackground } from '../presentation-status';
import { useImageAttachments } from './attachments';
import { useComposerDraft } from './draft';
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
  dormantResumeMetadata,
  formatContextTokens,
  resumeRuntimeRequest,
  runtimeSupportsImages,
  waitForStartedRuntime,
} from './runtime';
import {
  RuntimeModelControl,
  RuntimeThinkingControl,
} from './runtime-controls';
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
  const attachmentsEnabled = runtime
    ? runtime.liveState !== 'compacting' && runtimeSupportsImages(runtime)
    : dormantMetadata.supportsImages;
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
    if (runtime) setResumePending(false);
  }, [runtime]);
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
  if (!runtime)
    return (
      <ComposerShell
        ariaLabel="Send a message"
        onSubmit={(event) => void submit(event)}
        dragging={dragging}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        attachmentsEnabled={attachmentsEnabled}
        attachmentsBusy={submissionDisabled || busy || resumePending}
        fileInputRef={fileInputRef}
        attachments={attachments}
        onSelectImages={selectImages}
        onRemoveImage={removeImage}
        onPasteCapture={onPasteCapture}
        editorRef={editorRef}
        initialMarkdown={initialDraft}
        commands={composerCommands}
        onChange={updateText}
        placeholder="Message Pi…"
        readOnly={submissionDisabled || busy}
        submissionDisabled={submissionDisabled || busy}
        sendDisabled={
          submissionDisabled || busy || (!text.trim() && !attachments.length)
        }
        sendAriaLabel="Send message"
        mode={<span>Prompt</span>}
        controls={
          <span className="composer-resume-metadata">
            {dormantMetadata.model
              ? `${dormantMetadata.model.provider}/${dormantMetadata.model.model}`
              : '? model'}{' '}
            · {dormantMetadata.thinking ?? '? effort'} ·{' '}
            {dormantMetadata.contextTokens === undefined
              ? '? ctx'
              : `${formatContextTokens(dormantMetadata.contextTokens)} ctx`}
          </span>
        }
        notice={
          <div className="composer-notice" role="note">
            <strong>This session is dormant</strong>
            <p>Sending a message will resume Pi in this project checkout.</p>
            {resumePending && <output>Resuming…</output>}
          </div>
        }
        footer={
          !projectId || !checkoutId ? (
            <p className="error composer-error" role="alert">
              This session has no project checkout association.
            </p>
          ) : resumeError ? (
            <p className="error composer-error" role="alert">
              {resumeError}
            </p>
          ) : undefined
        }
      />
    );
  if (runtime.online === false)
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
    if (busy || commandMutation.isPending) return;
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
      {shouldShowQueuePanel(
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
        attachmentsBusy={disabled || busy}
        fileInputRef={fileInputRef}
        attachments={attachments}
        onSelectImages={selectImages}
        onRemoveImage={removeImage}
        onPasteCapture={onPasteCapture}
        editorRef={editorRef}
        initialMarkdown={initialDraft}
        commands={
          runtime.liveState === 'working' && !settledBackground
            ? composerCommands?.filter(
                (command) => command.source !== 'builtin',
              )
            : composerCommands
        }
        onChange={updateText}
        placeholder={disabled ? 'Agent is waiting for input' : 'Message Pi…'}
        readOnly={disabled || busy}
        submissionDisabled={submissionDisabled || busy}
        sendDisabled={
          submissionDisabled || busy || (!text.trim() && !attachments.length)
        }
        sendAriaLabel={queuesCurrentMessage ? 'Queue message' : 'Send'}
        sendSrOnly={queuesCurrentMessage ? 'Queue' : 'Send'}
        actionExtras={
          runtime.liveState === 'working' && !settledBackground ? (
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
            {runtime.liveState === 'working' && !settledBackground && (
              <>
                <span>Mode:</span>
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
              </>
            )}
            {(runtime.liveState === 'idle' || settledBackground) && (
              <span>Prompt</span>
            )}
            {runtime.liveState === 'waiting' && <span>Answer above</span>}
            <ContextIndicator usage={runtime.contextUsage} />
          </>
        }
        controls={
          <>
            <RuntimeModelControl runtime={runtime} runtimes={runtimes} />
            <RuntimeThinkingControl runtime={runtime} />
          </>
        }
        footer={
          error ? (
            <p className="error composer-error" role="alert">
              {error}
            </p>
          ) : undefined
        }
      />
    </>
  );
}
