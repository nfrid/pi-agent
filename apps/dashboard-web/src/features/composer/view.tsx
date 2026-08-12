import type { MDXEditorMethods } from '@mdxeditor/editor';
import {
  commandMutationOptions,
  composerCommandsQueryOptions,
  dashboardHttpClient,
  startRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useDashboardNavigate } from '../../routes/navigation';
import {
  ImageAttachmentInput,
  ImageAttachmentPreviews,
  useImageAttachments,
} from './attachments';
import { useComposerDraft } from './draft';
import { MarkdownComposerEditor } from './editor';
import {
  newQueueId,
  QueuePanel,
  queueCommand,
  shouldShowQueuePanel,
  upsertQueuedMessage,
  useComposerQueue,
} from './queue';
import {
  contextIndicatorData,
  resumeRuntimeRequest,
  runtimeSupportsImages,
} from './runtime';
import {
  RuntimeModelControl,
  RuntimeThinkingControl,
} from './runtime-controls';
import { ComposerRichSurface } from './shell';

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
      <span className="context-meter" aria-hidden="true">
        <i
          style={{
            width: `${Math.max(0, Math.min(100, indicator.percent ?? 0))}%`,
          }}
        />
      </span>
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
  sessionId,
  workspaceId,
  onMessageSubmitted,
  onPromptSubmitted,
}: {
  runtime: RuntimeSnapshot | undefined;
  runtimes?: readonly RuntimeSnapshot[];
  sessionId: string;
  workspaceId?: string;
  onMessageSubmitted?: () => void;
  onPromptSubmitted?: (text: string) => void;
}) {
  const go = useDashboardNavigate();
  const { initialDraft, text, updateText, clearDraft } =
    useComposerDraft(sessionId);
  const editorRef = useRef<MDXEditorMethods>(null);
  const [mode, setMode] = useState<'prompt' | 'steer' | 'followUp'>(() =>
    runtime?.liveState === 'working' ? 'steer' : 'prompt',
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string>();
  const [resumeWarning, setResumeWarning] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const commandMutation = useMutation(
    commandMutationOptions(dashboardHttpClient),
  );
  const resumeMutation = useMutation(
    startRuntimeMutationOptions(dashboardHttpClient),
  );
  const commandCatalogue = useQuery(
    composerCommandsQueryOptions(dashboardHttpClient, workspaceId ?? ''),
  );
  const composerCommands =
    runtime?.composerCommands ?? commandCatalogue.data?.commands;
  const [queue, setQueue] = useComposerQueue(runtime);
  const disabled =
    !runtime ||
    runtime.online === false ||
    runtime.liveState === 'stopping' ||
    runtime.liveState === 'compacting' ||
    runtime.liveState === 'waiting';
  const attachmentsEnabled = runtime ? runtimeSupportsImages(runtime) : false;
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
    busy: busy || disabled,
    onError: setError,
  });
  useEffect(() => {
    setMode(runtime?.liveState === 'working' ? 'steer' : 'prompt');
  }, [runtime?.liveState]);
  const resume = async (acknowledge = false) => {
    const request = resumeRuntimeRequest(workspaceId, sessionId, acknowledge);
    if (!request || resumeMutation.isPending) {
      if (!request)
        setResumeError('This session has no workspace association.');
      return;
    }
    setResumeError(undefined);
    setResumeWarning(false);
    try {
      await resumeMutation.mutateAsync(request);
      setResumePending(true);
    } catch (cause) {
      const details =
        cause instanceof Error
          ? (cause as Error & { code?: unknown })
          : { message: String(cause) };
      const message = details.message;
      setResumeError(message);
      setResumeWarning(
        (details as { code?: unknown }).code === 'shared-working-directory' ||
          /shared-working-directory|both agents/i.test(message),
      );
    }
  };
  if (!runtime && resumePending)
    return (
      <div className="composer disabled" role="status" aria-live="polite">
        <p>Starting agent…</p>
      </div>
    );
  if (!runtime)
    return (
      <div className="composer disabled">
        <p>This session is dormant.</p>
        <button
          type="button"
          disabled={resumeMutation.isPending}
          onClick={() => void resume()}
        >
          {resumeMutation.isPending ? 'Starting agent…' : 'Resume session'}
        </button>
        {resumeError && (
          <div className="composer-error" role="alert">
            <p className="error">{resumeError}</p>
            {resumeWarning && (
              <button
                type="button"
                className="secondary-button"
                disabled={resumeMutation.isPending}
                onClick={() => void resume(true)}
              >
                Continue
              </button>
            )}
          </div>
        )}
      </div>
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
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedText = text.trim();
    if ((!trimmedText && !attachments.length) || disabled || busy) return;
    if (attachments.length > 0 && !attachmentsEnabled) {
      setError('The selected model does not support image input.');
      return;
    }
    setBusy(true);
    setError(undefined);
    const command = {
      type: runtime.liveState === 'idle' ? 'prompt' : mode,
      text: trimmedText,
    };
    if (command.type === 'prompt') onPromptSubmitted?.(trimmedText);
    const queueTextOnly =
      runtime.liveState === 'working' && attachments.length === 0;
    try {
      if (queueTextOnly) {
        const queueId = newQueueId();
        await commandMutation.mutateAsync({
          runtimeId: runtime.runtimeId,
          command: queueCommand(
            'queue.add',
            queueId,
            mode === 'prompt' ? 'followUp' : mode,
            trimmedText,
          ),
        });
        setQueue((current) =>
          upsertQueuedMessage(current, {
            id: queueId,
            mode: mode === 'prompt' ? 'followUp' : mode,
            text: trimmedText,
          }),
        );
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
      clearAttachments();
      clearDraft();
      editorRef.current?.setMarkdown('');
      onMessageSubmitted?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {shouldShowQueuePanel(runtime.liveState, queue.length) && (
        <QueuePanel
          runtimeId={runtime.runtimeId}
          items={queue}
          onItemsChange={setQueue}
        />
      )}
      <form
        className={`composer ${dragging ? 'dragging' : ''}`}
        onSubmit={(event) => void submit(event)}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-label="Send a message"
      >
        <ImageAttachmentInput
          enabled={attachmentsEnabled}
          busy={disabled || busy}
          inputRef={fileInputRef}
          onFiles={selectImages}
        />
        <ImageAttachmentPreviews
          attachments={attachments}
          busy={busy}
          onRemove={removeImage}
        />
        <ComposerRichSurface onPasteCapture={onPasteCapture}>
          <Suspense
            fallback={
              <div className="composer-editor-loading" role="status">
                Loading editor…
              </div>
            }
          >
            <MarkdownComposerEditor
              ref={editorRef}
              initialMarkdown={initialDraft}
              commands={
                runtime.liveState === 'working'
                  ? composerCommands?.filter(
                      (command) => command.source !== 'builtin',
                    )
                  : composerCommands
              }
              onChange={updateText}
              placeholder={
                runtime.liveState === 'compacting'
                  ? 'Compacting context…'
                  : disabled
                    ? 'Agent is waiting for input'
                    : 'Message Pi…'
              }
              readOnly={disabled || busy}
            />
          </Suspense>
          <div className="composer-actions">
            <AriaButton
              type="button"
              className="composer-attach"
              isDisabled={!attachmentsEnabled || disabled || busy}
              onPress={() => fileInputRef.current?.click()}
              aria-label={
                attachmentsEnabled
                  ? 'Attach images'
                  : 'Attach images (unsupported by selected model)'
              }
            >
              <span aria-hidden="true">＋</span>
              <span className="composer-attach-label">Image</span>
            </AriaButton>
            <AriaButton
              type="submit"
              className="composer-send"
              isDisabled={
                disabled || busy || (!text.trim() && !attachments.length)
              }
              aria-label={
                runtime.liveState === 'working' && !attachments.length
                  ? 'Queue message'
                  : 'Send'
              }
            >
              <span aria-hidden="true">↑</span>
              <span className="sr-only">
                {runtime.liveState === 'working' && !attachments.length
                  ? 'Queue'
                  : 'Send'}
              </span>
            </AriaButton>
          </div>
        </ComposerRichSurface>
        <div className="composer-secondary">
          <div className="composer-mode">
            {runtime.liveState === 'working' && (
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
            {runtime.liveState === 'idle' && <span>Prompt</span>}
            {runtime.liveState === 'compacting' && (
              <span>Compacting context…</span>
            )}
            {runtime.liveState === 'waiting' && <span>Answer above</span>}
            <ContextIndicator usage={runtime.contextUsage} />
          </div>
          <div className="composer-control-row">
            <RuntimeModelControl runtime={runtime} runtimes={runtimes} />
            <RuntimeThinkingControl runtime={runtime} />
          </div>
          {error && (
            <p className="error composer-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </form>
    </>
  );
}
