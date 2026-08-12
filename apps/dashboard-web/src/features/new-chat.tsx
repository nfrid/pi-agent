import type { MDXEditorMethods } from '@mdxeditor/editor';
import {
  composerCommandsQueryOptions,
  type DashboardLiveStore,
  dashboardHttpClient,
  startRuntimeMutationOptions,
  useDashboardStore,
} from '@pi-dashboard/client';
import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  StartRuntimeRequest,
} from '@pi-dashboard/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  type FormEvent,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { newChatPath, useDashboardNavigate } from '../routes/navigation';
import { AgentThreadNav } from './agent-thread-nav';
import { MarkdownComposerEditor } from './composer';
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
  type RuntimeModelOption,
} from './model-option';

function errorDetails(cause: unknown): { message: string; code?: string } {
  if (cause instanceof Error) {
    const error = cause as Error & { code?: unknown };
    return {
      message: cause.message,
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    };
  }
  return { message: String(cause) };
}

function isSharedWorkingDirectoryWarning(message: string, code?: string) {
  return (
    code === 'shared-working-directory' ||
    /shared-working-directory|both agents/i.test(message)
  );
}

type NewChatModel = NonNullable<StartRuntimeRequest['model']>;

export async function waitForStartedRuntime(
  store: DashboardLiveStore,
  runtimeId: string,
  timeoutMs = 30_000,
): Promise<RuntimeSnapshot> {
  const current = () => store.getSnapshot().runtimesById[runtimeId];
  const ready = current();
  if (ready) return ready;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('The new runtime did not connect in time.'));
    }, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      const runtime = current();
      if (!runtime) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(runtime);
    });
  });
}

export function preferredNewChatRuntime(
  workspacePath: string,
  runtimes: readonly RuntimeSnapshot[],
): RuntimeSnapshot | undefined {
  return [...runtimes]
    .filter((runtime) => runtime.cwd === workspacePath)
    .sort(
      (left, right) =>
        Number(right.online !== false) - Number(left.online !== false) ||
        (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0),
    )[0];
}

export function newChatModelOptions(
  runtimes: readonly RuntimeSnapshot[],
  preferred?: RuntimeSnapshot,
): readonly RuntimeModelOption[] {
  return configuredModelOptions(runtimes, preferred);
}

export function newChatThinkingLevels(
  runtimes: readonly RuntimeSnapshot[],
  preferred?: RuntimeSnapshot,
): readonly string[] {
  const levels = new Set<string>();
  for (const level of preferred?.thinkingLevels ?? []) levels.add(level);
  for (const runtime of runtimes)
    for (const level of runtime.thinkingLevels ?? []) levels.add(level);
  return [...levels];
}

export function newChatRequest(
  workspaceId: string,
  initialPrompt: string | undefined,
  acknowledgeSharedWorkingDirectory = false,
  model?: NewChatModel,
): StartRuntimeRequest {
  return {
    workspaceId,
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(model ? { model } : {}),
    ...(acknowledgeSharedWorkingDirectory
      ? { acknowledgeSharedWorkingDirectory: true }
      : {}),
  };
}

export function sessionPathForRuntime(
  runtime: RuntimeSnapshot | undefined,
): string | undefined {
  const sessionId = runtime?.session.id;
  return sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : undefined;
}

export function pendingChatPath(
  workspaceId: string,
  runtimeId: string,
): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/new/pending/${encodeURIComponent(runtimeId)}`;
}

export function NewChatView({
  workspaceId,
  pendingRuntimeId,
  snapshot,
  store,
}: {
  workspaceId: string;
  pendingRuntimeId?: string;
  snapshot: BrowserSnapshot;
  store: DashboardLiveStore;
}) {
  const go = useDashboardNavigate();
  const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
  const [agentNavOpen, setAgentNavOpen] = useState(false);
  const preferredRuntime = useMemo(
    () =>
      workspace
        ? preferredNewChatRuntime(workspace.canonicalPath, snapshot.runtimes)
        : undefined,
    [snapshot.runtimes, workspace],
  );
  const modelOptions = useMemo(
    () => newChatModelOptions(snapshot.runtimes, preferredRuntime),
    [preferredRuntime, snapshot.runtimes],
  );
  const thinkingLevels = useMemo(
    () => newChatThinkingLevels(snapshot.runtimes, preferredRuntime),
    [preferredRuntime, snapshot.runtimes],
  );
  const preferredModelValue = preferredRuntime?.model
    ? modelOptionValue(
        preferredRuntime.model.provider,
        preferredRuntime.model.model,
      )
    : '';
  const [text, setText] = useState('');
  const editorRef = useRef<MDXEditorMethods>(null);
  const [busy, setBusy] = useState(false);
  const [startedRuntimeId, setStartedRuntimeId] = useState<string>();
  const [modelValue, setModelValue] = useState(() =>
    modelOptions.some(
      (model) =>
        modelOptionValue(model.provider, model.model) === preferredModelValue,
    )
      ? preferredModelValue
      : modelOptions[0]
        ? modelOptionValue(modelOptions[0].provider, modelOptions[0].model)
        : '',
  );
  const [thinking, setThinking] = useState(() =>
    preferredRuntime?.model?.thinking &&
    thinkingLevels.includes(preferredRuntime.model.thinking)
      ? preferredRuntime.model.thinking
      : (thinkingLevels[0] ?? ''),
  );
  const [error, setError] = useState<string>();
  const [sharedWarning, setSharedWarning] = useState(false);
  const runtime = useDashboardStore(
    store,
    (state) =>
      (pendingRuntimeId && state.runtimesById[pendingRuntimeId]) || undefined,
  );
  const mutation = useMutation(
    startRuntimeMutationOptions(dashboardHttpClient),
  );
  const commandCatalogue = useQuery(
    composerCommandsQueryOptions(dashboardHttpClient, workspaceId),
  );
  const composerCommands =
    commandCatalogue.data?.commands ?? preferredRuntime?.composerCommands ?? [];
  const sessionPath = sessionPathForRuntime(runtime);
  const selectedModel = modelOptions.find(
    (model) => modelOptionValue(model.provider, model.model) === modelValue,
  );
  const attachmentsEnabled = selectedModel?.supportsImages === true;
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
    busy,
    onError: setError,
  });

  useEffect(() => {
    if (
      modelOptions.some(
        (model) => modelOptionValue(model.provider, model.model) === modelValue,
      )
    )
      return;
    const preferred = modelOptions.find(
      (model) =>
        modelOptionValue(model.provider, model.model) === preferredModelValue,
    );
    const model = preferred ?? modelOptions[0];
    setModelValue(model ? modelOptionValue(model.provider, model.model) : '');
  }, [modelOptions, modelValue, preferredModelValue]);
  useEffect(() => {
    if (thinkingLevels.includes(thinking)) return;
    const preferredThinking = preferredRuntime?.model?.thinking;
    setThinking(
      preferredThinking && thinkingLevels.includes(preferredThinking)
        ? preferredThinking
        : (thinkingLevels[0] ?? ''),
    );
  }, [preferredRuntime, thinking, thinkingLevels]);
  useEffect(() => {
    if (!pendingRuntimeId || !sessionPath) return;
    go(sessionPath);
  }, [go, pendingRuntimeId, sessionPath]);

  if (!workspace) {
    return (
      <section className="new-chat-missing">
        <h1>Workspace not found</h1>
        <p className="error" role="alert">
          This workspace is no longer available.
        </p>
        <button type="button" onClick={() => go(newChatPath(snapshot))}>
          Choose a workspace
        </button>
      </section>
    );
  }

  const submit = async (event: FormEvent, acknowledge = false) => {
    event.preventDefault();
    const initialPrompt = text.trim();
    if ((!initialPrompt && !attachments.length) || busy) return;
    if (attachments.length > 0 && !attachmentsEnabled) {
      setError('The selected model does not support image input.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setSharedWarning(false);
    try {
      let runtimeId = startedRuntimeId;
      if (!runtimeId) {
        const result = await mutation.mutateAsync(
          newChatRequest(
            workspaceId,
            attachments.length ? undefined : initialPrompt,
            acknowledge,
            selectedModel && {
              provider: selectedModel.provider,
              model: selectedModel.model,
              ...(thinking ? { thinking } : {}),
            },
          ),
        );
        runtimeId = result.runtimeId;
        if (attachments.length) setStartedRuntimeId(runtimeId);
      }
      store.optimisticallyTitleRuntime(runtimeId, initialPrompt);
      if (attachments.length) {
        const started = await waitForStartedRuntime(store, runtimeId);
        if (started.model?.supportsImages !== true)
          throw new Error('The new runtime does not support image input.');
        await dashboardHttpClient.sendCommandWithImages(
          runtimeId,
          { type: 'prompt', text: initialPrompt },
          attachments.map((attachment) => attachment.file),
        );
      }
      clearAttachments();
      go(pendingChatPath(workspaceId, runtimeId));
    } catch (cause) {
      const details = errorDetails(cause);
      setError(details.message);
      setSharedWarning(
        isSharedWorkingDirectoryWarning(details.message, details.code),
      );
    } finally {
      setBusy(false);
    }
  };

  if (pendingRuntimeId) {
    return (
      <div className="session-layout new-chat-layout">
        <AgentThreadNav
          snapshot={snapshot}
          mode="session"
          open={agentNavOpen}
          onOpenChange={setAgentNavOpen}
        />
        <section className="new-chat-page new-chat-pending" aria-live="polite">
          <header className="new-chat-heading">
            <div>
              <p className="eyebrow">{workspace.name}</p>
              <h1>New chat</h1>
            </div>
          </header>
          <div className="new-chat-pending-state" role="status">
            <span className="session-loading-indicator" aria-hidden="true" />
            <strong>Starting agent…</strong>
            <p className="muted">Your chat will open as soon as it is ready.</p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="session-layout new-chat-layout">
      <AgentThreadNav
        snapshot={snapshot}
        mode="session"
        open={agentNavOpen}
        onOpenChange={setAgentNavOpen}
      />
      <section className="new-chat-page" aria-label="New chat">
        <header className="new-chat-heading">
          <div>
            <p className="eyebrow">{workspace.name}</p>
            <h1>New chat</h1>
          </div>
        </header>
        <div className="new-chat-empty">
          <div className="new-chat-intro">
            <span className="empty-mark" aria-hidden="true">
              ›_
            </span>
            <h2>Start a conversation</h2>
            <p className="muted">What would you like to work on?</p>
          </div>
          <form
            className={`composer new-chat-composer ${dragging ? 'dragging' : ''}`}
            aria-label="Start a new chat"
            onSubmit={(event) => void submit(event)}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <ImageAttachmentInput
              enabled={attachmentsEnabled}
              busy={busy}
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
                  commands={composerCommands}
                  onChange={setText}
                  placeholder="Message Pi…"
                  readOnly={busy}
                />
              </Suspense>
              <div className="composer-actions">
                <AriaButton
                  type="button"
                  className="composer-attach"
                  isDisabled={!attachmentsEnabled || busy}
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
                    busy || (!text.trim() && attachments.length === 0)
                  }
                  aria-label="Send first message"
                >
                  <span aria-hidden="true">↑</span>
                </AriaButton>
              </div>
            </ComposerRichSurface>
            <div className="composer-secondary">
              <div className="composer-mode">
                <span>Prompt</span>
              </div>
              <div className="composer-control-row">
                <ComposerModelControl
                  models={modelOptions}
                  value={modelValue}
                  disabled={busy || Boolean(startedRuntimeId)}
                  onChange={setModelValue}
                />
                <ComposerThinkingControl
                  levels={thinkingLevels}
                  value={thinking}
                  disabled={busy || Boolean(startedRuntimeId)}
                  onChange={setThinking}
                />
              </div>
              {error && (
                <div className="new-chat-error" role="alert">
                  <p className="error">{error}</p>
                  {sharedWarning && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={(event) => void submit(event, true)}
                    >
                      Continue
                    </button>
                  )}
                </div>
              )}
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
