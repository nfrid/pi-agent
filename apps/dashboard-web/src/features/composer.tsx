import {
  commandMutationOptions,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';

function useDashboardNavigate(): (path: string) => void {
  const navigate = useNavigate();
  return (path) => void navigate({ to: path });
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_IMAGE_ATTACHMENTS = 4;
type RuntimeWithModelCatalog = RuntimeSnapshot & {
  modelCatalog?: readonly {
    provider: string;
    model: string;
    name?: string;
    supportsImages?: boolean;
  }[];
  thinkingLevels?: readonly string[];
};
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_SIZE = 12 * 1024 * 1024;

type ImageAttachment = { file: File; previewUrl: string };

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
      <strong>{indicator.text}</strong>
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

function ModelControls({ runtime }: { runtime: RuntimeSnapshot }) {
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const [modelValue, setModelValue] = useState(
    runtime.model ? `${runtime.model.provider}/${runtime.model.model}` : '',
  );
  const [thinking, setThinking] = useState(runtime.model?.thinking ?? 'off');
  const [error, setError] = useState<string>();
  useEffect(() => {
    setModelValue(
      runtime.model ? `${runtime.model.provider}/${runtime.model.model}` : '',
    );
    setThinking(runtime.model?.thinking ?? 'off');
  }, [runtime.model]);
  const unavailable =
    runtime.online === false || runtime.liveState === 'stopping';
  const setModel = async (value: string) => {
    const separator = value.indexOf('/');
    if (separator < 1) return;
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: {
          type: 'setModel',
          provider: value.slice(0, separator),
          model: value.slice(separator + 1),
        },
      });
      setModelValue(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
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
  const catalogRuntime = runtime as RuntimeWithModelCatalog;
  const models =
    catalogRuntime.modelCatalog ??
    (runtime.model
      ? [
          {
            provider: runtime.model.provider,
            model: runtime.model.model,
            supportsImages: runtime.model.supportsImages,
          },
        ]
      : []);
  const levels =
    catalogRuntime.thinkingLevels ??
    (runtime.model?.thinking ? [runtime.model.thinking] : []);
  if (!models.length && !levels.length && !error) return null;
  return (
    <fieldset className="model-controls">
      <legend className="sr-only">Model controls</legend>
      {models.length > 0 && (
        <label>
          <span>Model</span>
          <select
            aria-label="Model"
            value={modelValue}
            disabled={unavailable || command.isPending}
            onChange={(event) => void setModel(event.target.value)}
          >
            {models.map((model) => {
              const value = `${model.provider}/${model.model}`;
              return (
                <option value={value} key={value}>
                  {model.name ?? value}
                </option>
              );
            })}
          </select>
        </label>
      )}
      {levels.length > 0 && (
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
      )}
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
}: {
  runtime: RuntimeSnapshot | undefined;
  sessionId: string;
}) {
  const go = useDashboardNavigate();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'prompt' | 'steer' | 'followUp'>('prompt');
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentsRef = useRef<ImageAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const commandMutation = useMutation(
    commandMutationOptions(dashboardHttpClient),
  );
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
    setMode(runtime?.liveState === 'working' ? 'followUp' : 'prompt');
  }, [runtime?.liveState]);
  useEffect(() => {
    if (attachmentsEnabled) return;
    setAttachments((current) => {
      for (const attachment of current)
        URL.revokeObjectURL(attachment.previewUrl);
      return [];
    });
  }, [attachmentsEnabled]);
  if (!runtime)
    return (
      <div className="composer disabled">
        <p>This session is dormant.</p>
        <button type="button" onClick={() => go('/new')}>
          Resume in a new runtime
        </button>
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
    try {
      if (attachments.length)
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
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
      <div className="composer-secondary">
        <div className="composer-mode">
          {runtime.liveState === 'working' && (
            <>
              <span>Mode:</span>
              <AriaButton
                type="button"
                aria-pressed={mode === 'followUp'}
                className={mode === 'followUp' ? 'selected' : ''}
                onPress={() => setMode('followUp')}
              >
                Follow-up
              </AriaButton>
              <AriaButton
                type="button"
                aria-pressed={mode === 'steer'}
                className={mode === 'steer' ? 'selected' : ''}
                onPress={() => setMode('steer')}
              >
                Steer
              </AriaButton>
            </>
          )}
          {runtime.liveState === 'idle' && <span>Prompt</span>}
          {runtime.liveState === 'waiting' && <span>Answer above</span>}
          <ContextIndicator usage={runtime.contextUsage} />
          <span className="shortcut">
            Ctrl/⌘+Enter send · Shift+Enter newline
          </span>
        </div>
        <div className="composer-model-row">
          <ModelControls runtime={runtime} />
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {attachmentsEnabled ? (
          <>
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
            {attachments.length > 0 && (
              <fieldset className="composer-previews">
                <legend className="sr-only">Image attachments</legend>
                {attachments.map((attachment) => (
                  <div className="composer-preview" key={attachment.previewUrl}>
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.file.name}
                    />
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
            <AriaButton
              type="button"
              className="composer-attach"
              isDisabled={disabled || busy}
              onPress={() => fileInputRef.current?.click()}
              aria-label="Attach images"
            >
              + Image
            </AriaButton>
          </>
        ) : (
          <AriaButton
            type="button"
            className="composer-attach"
            isDisabled
            aria-label="Attach images (unsupported by selected model)"
          >
            + Image
          </AriaButton>
        )}
      </div>
      <div className="composer-primary">
        <textarea
          aria-label="Message Pi"
          value={text}
          disabled={disabled || busy}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
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
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !event.shiftKey
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={disabled ? 'Agent is waiting for input' : 'Message Pi…'}
          rows={3}
        />
        <AriaButton
          type="submit"
          isDisabled={disabled || busy || (!text.trim() && !attachments.length)}
        >
          Send
        </AriaButton>
      </div>
    </form>
  );
}
