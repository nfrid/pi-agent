import type { MDXEditorMethods } from '@mdxeditor/editor';
import {
  commandMutationOptions,
  composerCommandsQueryOptions,
  dashboardHttpClient,
  startRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type {
  RuntimeSnapshot,
  StartRuntimeRequest,
} from '@pi-dashboard/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useDashboardNavigate } from '../routes/navigation';
import {
  ImageAttachmentInput,
  ImageAttachmentPreviews,
  useImageAttachments,
} from './composer/attachments';
import {
  ComposerModelControl,
  ComposerThinkingControl,
} from './composer/controls';
import { ComposerRichSurface } from './composer/shell';
import {
  configuredModelOptions,
  modelOptionValue,
  parseModelOptionValue,
} from './model-option';

export {
  addImageAttachments,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_SIZE,
  MAX_IMAGE_TOTAL_SIZE,
} from './composer/attachments';
export const MarkdownComposerEditor = lazy(
  () => import('./markdown-composer-editor'),
);
export const COMPOSER_DRAFT_STORAGE_PREFIX = 'pi-dashboard-composer-draft:';
const COMPOSER_DRAFT_WRITE_DELAY = 350;

export function composerDraftStorageKey(sessionId: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function readComposerDraft(sessionId: string): string {
  try {
    return (
      globalThis.localStorage?.getItem(composerDraftStorageKey(sessionId)) ?? ''
    );
  } catch {
    return '';
  }
}

export function writeComposerDraft(sessionId: string, text: string): void {
  try {
    const key = composerDraftStorageKey(sessionId);
    if (text) globalThis.localStorage?.setItem(key, text);
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Draft persistence is best-effort when storage is unavailable or full.
  }
}

export type QueuedMessage = {
  id: string;
  mode: 'steer' | 'followUp';
  text: string;
};

export function resumeRuntimeRequest(
  workspaceId: string | undefined,
  sessionId: string,
  acknowledgeSharedWorkingDirectory = false,
): StartRuntimeRequest | undefined {
  if (!workspaceId) return undefined;
  return {
    workspaceId,
    sessionId,
    ...(acknowledgeSharedWorkingDirectory
      ? { acknowledgeSharedWorkingDirectory: true }
      : {}),
  };
}

export function queuedMessagesForRuntime(
  runtime: RuntimeSnapshot | undefined,
): readonly QueuedMessage[] {
  const queue = runtime?.queueDrafts;
  if (!Array.isArray(queue)) return [];
  const seen = new Set<string>();
  return queue.flatMap((item) => {
    if (
      !item ||
      typeof item.clientId !== 'string' ||
      item.clientId.length === 0 ||
      (item.mode !== 'steer' && item.mode !== 'followUp') ||
      typeof item.text !== 'string' ||
      seen.has(item.clientId)
    )
      return [];
    seen.add(item.clientId);
    return [{ id: item.clientId, mode: item.mode, text: item.text }];
  });
}

/** Add or replace a queue item without creating duplicate client IDs. */
export function upsertQueuedMessage(
  items: readonly QueuedMessage[],
  item: QueuedMessage,
): QueuedMessage[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((candidate, candidateIndex) =>
    candidateIndex === index ? item : candidate,
  );
}

function newQueueId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function queueCommand(
  type: 'queue.add' | 'queue.update',
  clientId: string,
  mode: 'steer' | 'followUp',
  text: string,
): Record<string, unknown> {
  return {
    id: newQueueId(),
    type,
    clientId,
    mode,
    text: text.trim(),
  };
}

export function queueRemoveCommand(clientId: string): Record<string, unknown> {
  return { id: newQueueId(), type: 'queue.remove', clientId };
}

export function shouldShowQueuePanel(
  liveState: RuntimeSnapshot['liveState'],
  queuedCount: number,
): boolean {
  return (
    liveState === 'working' || liveState === 'compacting' || queuedCount > 0
  );
}

export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${Number.parseFloat((tokens / 1_000_000).toFixed(1))}m`;
  if (tokens >= 1_000)
    return `${Number.parseFloat((tokens / 1_000).toFixed(1))}k`;
  return `${tokens}`;
}

export function contextIndicatorData(
  usage: RuntimeSnapshot['contextUsage'],
):
  | { percent?: number; text: string; level: 'normal' | 'warning' | 'error' }
  | undefined {
  if (!usage?.contextWindow) return undefined;
  const percent =
    usage.tokens === null
      ? undefined
      : Math.round(usage.percent ?? (usage.tokens / usage.contextWindow) * 100);
  const level =
    percent !== undefined && percent >= 80
      ? 'error'
      : percent !== undefined && percent >= 50
        ? 'warning'
        : 'normal';
  const used = usage.tokens === null ? '?' : formatContextTokens(usage.tokens);
  return {
    percent,
    text: `${percent ?? '?'}% [${used}/${formatContextTokens(usage.contextWindow)}]`,
    level,
  };
}

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

export function runtimeSupportsImages(runtime: RuntimeSnapshot): boolean {
  return runtime.model?.supportsImages === true;
}

function QueuePanel({
  runtimeId,
  items,
  onItemsChange,
}: {
  runtimeId: string;
  items: readonly QueuedMessage[];
  onItemsChange: (items: QueuedMessage[]) => void;
}) {
  const mutation = useMutation(commandMutationOptions(dashboardHttpClient));
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState('');
  const [error, setError] = useState<string>();
  const beginEdit = (item: QueuedMessage) => {
    setEditingId(item.id);
    setEditingText(item.text);
    setError(undefined);
  };
  const save = async (item: QueuedMessage) => {
    const text = editingText.trim();
    if (!text || mutation.isPending) return;
    setError(undefined);
    try {
      await mutation.mutateAsync({
        runtimeId,
        command: queueCommand('queue.update', item.id, item.mode, text),
      });
      onItemsChange(
        items.map((candidate) =>
          candidate.id === item.id ? { ...candidate, text } : candidate,
        ),
      );
      setEditingId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const remove = async (item: QueuedMessage) => {
    if (mutation.isPending) return;
    setError(undefined);
    try {
      await mutation.mutateAsync({
        runtimeId,
        command: queueRemoveCommand(item.id),
      });
      onItemsChange(items.filter((candidate) => candidate.id !== item.id));
      if (editingId === item.id) setEditingId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  if (!items.length) return null;
  return (
    <section className="queue-panel" aria-label="Queued messages">
      <div className="queue-heading">
        <span className="eyebrow">Queue</span>
        <span>{items.length} waiting</span>
      </div>
      <div className="queue-list">
        {items.map((item) => {
          const editing = editingId === item.id;
          return (
            <div className="queue-item" key={item.id}>
              <span className={`queue-mode queue-${item.mode}`}>
                {item.mode === 'steer' ? 'steer' : 'follow-up'}
              </span>
              {editing ? (
                <input
                  aria-label={`Edit queued ${item.mode} message`}
                  value={editingText}
                  onChange={(event) => setEditingText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void save(item);
                    }
                    if (event.key === 'Escape') setEditingId(undefined);
                  }}
                  disabled={mutation.isPending}
                />
              ) : (
                <span className="queue-text">{item.text}</span>
              )}
              <div className="queue-actions">
                {editing ? (
                  <AriaButton
                    type="button"
                    isDisabled={mutation.isPending || !editingText.trim()}
                    onPress={() => void save(item)}
                  >
                    Save
                  </AriaButton>
                ) : (
                  <AriaButton
                    type="button"
                    isDisabled={mutation.isPending}
                    onPress={() => beginEdit(item)}
                  >
                    Edit
                  </AriaButton>
                )}
                <AriaButton
                  type="button"
                  className="queue-remove"
                  isDisabled={mutation.isPending}
                  onPress={() => void remove(item)}
                >
                  Remove
                </AriaButton>
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <p className="error queue-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ModelControl({
  runtime,
  runtimes,
}: {
  runtime: RuntimeSnapshot;
  runtimes: readonly RuntimeSnapshot[];
}) {
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const [modelValue, setModelValue] = useState(
    runtime.model
      ? modelOptionValue(runtime.model.provider, runtime.model.model)
      : '',
  );
  const [error, setError] = useState<string>();
  useEffect(
    () =>
      setModelValue(
        runtime.model
          ? modelOptionValue(runtime.model.provider, runtime.model.model)
          : '',
      ),
    [runtime.model],
  );
  const models = configuredModelOptions(runtimes, runtime);
  const unavailable =
    runtime.online === false || runtime.liveState === 'stopping';
  const setModel = async (value: string) => {
    const selected = parseModelOptionValue(value);
    if (!selected) return;
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: { type: 'setModel', ...selected },
      });
      setModelValue(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <ComposerModelControl
      models={models}
      value={modelValue}
      disabled={unavailable || command.isPending}
      onChange={(value) => void setModel(value)}
      error={error}
    />
  );
}

function ThinkingControl({ runtime }: { runtime: RuntimeSnapshot }) {
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const [thinking, setThinking] = useState(runtime.model?.thinking ?? 'off');
  const [error, setError] = useState<string>();
  useEffect(
    () => setThinking(runtime.model?.thinking ?? 'off'),
    [runtime.model?.thinking],
  );
  const levels =
    runtime.thinkingLevels ??
    (runtime.model?.thinking ? [runtime.model.thinking] : []);
  const unavailable =
    runtime.online === false || runtime.liveState === 'stopping';
  const setLevel = async (level: string) => {
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: { type: 'setThinking', level },
      });
      setThinking(level);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <ComposerThinkingControl
      levels={levels}
      value={thinking}
      disabled={unavailable || command.isPending}
      onChange={(level) => void setLevel(level)}
      error={error}
    />
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
  const [initialDraft] = useState(() => readComposerDraft(sessionId));
  const [text, setText] = useState(initialDraft);
  const draftTextRef = useRef(initialDraft);
  const updateText = useCallback((next: string) => {
    draftTextRef.current = next;
    setText(next);
  }, []);
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
  const serverQueue = queuedMessagesForRuntime(runtime);
  const serverQueueKey = JSON.stringify(serverQueue);
  const serverQueueKeyRef = useRef(serverQueueKey);
  const [queue, setQueue] = useState<QueuedMessage[]>(() => [...serverQueue]);
  useEffect(() => {
    if (serverQueueKeyRef.current === serverQueueKey) return;
    serverQueueKeyRef.current = serverQueueKey;
    setQueue([...serverQueue]);
  }, [serverQueue, serverQueueKey]);
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
    const timeout = window.setTimeout(
      () => writeComposerDraft(sessionId, text),
      COMPOSER_DRAFT_WRITE_DELAY,
    );
    return () => window.clearTimeout(timeout);
  }, [sessionId, text]);
  useEffect(
    () => () => writeComposerDraft(sessionId, draftTextRef.current),
    [sessionId],
  );
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
      draftTextRef.current = '';
      writeComposerDraft(sessionId, '');
      setText('');
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
            <ModelControl runtime={runtime} runtimes={runtimes} />
            <ThinkingControl runtime={runtime} />
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
