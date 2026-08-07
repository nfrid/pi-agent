import type { MDXEditorMethods } from '@mdxeditor/editor';
import {
  commandMutationOptions,
  dashboardHttpClient,
  startRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type {
  RuntimeSnapshot,
  StartRuntimeRequest,
} from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import {
  type FormEvent,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useDashboardNavigate } from '../routes/navigation';
import { modelOptionValue, parseModelOptionValue } from './model-option';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MarkdownComposerEditor = lazy(() => import('./markdown-composer-editor'));
export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_SIZE = 12 * 1024 * 1024;

type ImageAttachment = { file: File; previewUrl: string };

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
  return queue.flatMap((item) =>
    item &&
    typeof item.clientId === 'string' &&
    item.clientId.length > 0 &&
    (item.mode === 'steer' || item.mode === 'followUp') &&
    typeof item.text === 'string'
      ? [{ id: item.clientId, mode: item.mode, text: item.text }]
      : [],
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
  return liveState === 'working' || queuedCount > 0;
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
      title="Current context window usage"
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

export function addImageAttachments(
  existing: readonly File[],
  incoming: readonly File[],
): { accepted: File[]; error?: string } {
  const accepted: File[] = [];
  let totalSize = existing.reduce((total, file) => total + file.size, 0);
  let error: string | undefined;
  for (const file of incoming) {
    if (file.size === 0) {
      error ??= `${file.name} is empty.`;
      continue;
    }
    if (!IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number])) {
      error ??= `${file.name} is not a PNG, JPEG, or WebP image.`;
      continue;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      error ??= `${file.name} is larger than the 5 MiB image limit.`;
      continue;
    }
    if (existing.length + accepted.length >= MAX_IMAGE_ATTACHMENTS) {
      error ??= `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`;
      continue;
    }
    if (totalSize + file.size > MAX_IMAGE_TOTAL_SIZE) {
      error ??= 'Attached images exceed the 12 MiB total limit.';
      continue;
    }
    accepted.push(file);
    totalSize += file.size;
  }
  return { accepted, ...(error ? { error } : {}) };
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

function ModelControl({ runtime }: { runtime: RuntimeSnapshot }) {
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
  const models =
    runtime.modelCatalog ??
    (runtime.model
      ? [
          {
            provider: runtime.model.provider,
            model: runtime.model.model,
          },
        ]
      : []);
  if (!models.length && !error) return null;
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
    <fieldset className="model-control">
      <legend className="sr-only">Model control</legend>
      <label>
        <span>Model</span>
        <select
          aria-label="Model"
          value={modelValue}
          disabled={unavailable || command.isPending}
          onChange={(event) => void setModel(event.target.value)}
        >
          {models.map((model) => {
            const value = modelOptionValue(model.provider, model.model);
            return (
              <option value={value} key={value}>
                {model.name ?? value}
              </option>
            );
          })}
        </select>
      </label>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
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
  if (!levels.length && !error) return null;
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
    <fieldset className="thinking-control">
      <legend className="sr-only">Thinking control</legend>
      <label>
        <span>Thinking</span>
        <select
          aria-label="Thinking level"
          value={thinking}
          disabled={unavailable || command.isPending}
          onChange={(event) => void setLevel(event.target.value)}
        >
          {levels.map((level) => (
            <option value={level} key={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}

export function Composer({
  runtime,
  sessionId,
  workspaceId,
}: {
  runtime: RuntimeSnapshot | undefined;
  sessionId: string;
  workspaceId?: string;
}) {
  const go = useDashboardNavigate();
  const [text, setText] = useState('');
  const editorRef = useRef<MDXEditorMethods>(null);
  const [mode, setMode] = useState<'prompt' | 'steer' | 'followUp'>(() =>
    runtime?.liveState === 'working' ? 'steer' : 'prompt',
  );
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentsRef = useRef<ImageAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
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
    runtime.liveState === 'waiting';
  const attachmentsEnabled = runtime ? runtimeSupportsImages(runtime) : false;
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current)
        URL.revokeObjectURL(attachment.previewUrl);
    },
    [],
  );
  useEffect(() => {
    setMode(runtime?.liveState === 'working' ? 'steer' : 'prompt');
  }, [runtime?.liveState]);
  useEffect(() => {
    if (attachmentsEnabled) return;
    setAttachments((current) => {
      for (const attachment of current)
        URL.revokeObjectURL(attachment.previewUrl);
      return [];
    });
  }, [attachmentsEnabled]);
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
  const selectImages = (files: readonly File[]) => {
    if (!attachmentsEnabled || disabled || busy) return;
    const result = addImageAttachments(
      attachments.map((attachment) => attachment.file),
      files,
    );
    if (result.accepted.length) {
      setAttachments((current) => [
        ...current,
        ...result.accepted.map((file) => ({
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      ]);
    }
    setError(result.error);
  };
  const removeImage = (previewUrl: string) => {
    const attachment = attachments.find(
      (candidate) => candidate.previewUrl === previewUrl,
    );
    if (!attachment) return;
    URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) =>
      current.filter((candidate) => candidate.previewUrl !== previewUrl),
    );
  };
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
        setQueue((current) => [
          ...current,
          {
            id: queueId,
            mode: mode === 'prompt' ? 'followUp' : mode,
            text: trimmedText,
          },
        ]);
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
      for (const attachment of attachments)
        URL.revokeObjectURL(attachment.previewUrl);
      setAttachments([]);
      setText('');
      editorRef.current?.setMarkdown('');
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
        onDragEnter={(event) => {
          if (!attachmentsEnabled || disabled || busy) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!attachmentsEnabled || disabled || busy) return;
          event.preventDefault();
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (!attachmentsEnabled || disabled || busy) return;
          event.preventDefault();
          setDragging(false);
          selectImages(Array.from(event.dataTransfer.files));
        }}
        aria-label="Send a message"
      >
        {attachmentsEnabled && (
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept={IMAGE_TYPES.join(',')}
            multiple
            aria-label="Choose images"
            disabled={disabled || busy}
            onChange={(event) => {
              selectImages(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        )}
        {attachments.length > 0 && (
          <fieldset className="composer-previews">
            <legend className="sr-only">Image attachments</legend>
            {attachments.map((attachment) => (
              <div className="composer-preview" key={attachment.previewUrl}>
                <img src={attachment.previewUrl} alt={attachment.file.name} />
                <button
                  type="button"
                  aria-label={`Remove ${attachment.file.name}`}
                  disabled={busy}
                  onClick={() => removeImage(attachment.previewUrl)}
                >
                  ×
                </button>
              </div>
            ))}
          </fieldset>
        )}
        <div
          className="composer-primary composer-rich-surface"
          onPasteCapture={(event) => {
            if (!attachmentsEnabled || disabled || busy) return;
            const files = Array.from(event.clipboardData.files);
            const itemFiles = Array.from(event.clipboardData.items).flatMap(
              (item) => {
                const file = item.kind === 'file' ? item.getAsFile() : null;
                return file ? [file] : [];
              },
            );
            const images = files.length ? files : itemFiles;
            if (!images.length) return;
            event.preventDefault();
            selectImages(images);
          }}
          onKeyDownCapture={(event) => {
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !event.shiftKey
            ) {
              event.preventDefault();
              event.currentTarget.closest('form')?.requestSubmit();
            }
          }}
        >
          <Suspense
            fallback={
              <div className="composer-editor-loading" role="status">
                Loading editor…
              </div>
            }
          >
            <MarkdownComposerEditor
              ref={editorRef}
              onChange={setText}
              placeholder={
                disabled ? 'Agent is waiting for input' : 'Message Pi…'
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
        </div>
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
            {runtime.liveState === 'waiting' && <span>Answer above</span>}
            <ContextIndicator usage={runtime.contextUsage} />
          </div>
          <div className="composer-control-row">
            <ModelControl runtime={runtime} />
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
