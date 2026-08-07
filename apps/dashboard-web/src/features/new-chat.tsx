import {
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
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { newChatPath, useDashboardNavigate } from '../routes/navigation';
import { AgentThreadNav } from './agent-thread-nav';
import { modelOptionValue } from './model-option';

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
type RuntimeModelOption = NonNullable<RuntimeSnapshot['modelCatalog']>[number];

export function newChatModelOptions(
  runtimes: readonly RuntimeSnapshot[],
): readonly RuntimeModelOption[] {
  const options = new Map<string, RuntimeModelOption>();
  for (const runtime of runtimes) {
    if (runtime.model) {
      const value = modelOptionValue(
        runtime.model.provider,
        runtime.model.model,
      );
      options.set(value, {
        provider: runtime.model.provider,
        model: runtime.model.model,
        supportsImages: runtime.model.supportsImages,
      });
    }
    for (const model of runtime.modelCatalog ?? []) {
      const value = modelOptionValue(model.provider, model.model);
      options.set(value, model);
    }
  }
  return [...options.values()];
}

export function newChatRequest(
  workspaceId: string,
  initialPrompt: string,
  acknowledgeSharedWorkingDirectory = false,
  model?: NewChatModel,
): StartRuntimeRequest {
  return {
    workspaceId,
    initialPrompt,
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
  const modelOptions = useMemo(
    () => newChatModelOptions(snapshot.runtimes),
    [snapshot.runtimes],
  );
  const [text, setText] = useState('');
  const [modelValue, setModelValue] = useState(() => {
    const model = modelOptions[0];
    return model ? modelOptionValue(model.provider, model.model) : '';
  });
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
  const sessionPath = sessionPathForRuntime(runtime);

  useEffect(() => {
    if (
      modelOptions.some(
        (model) => modelOptionValue(model.provider, model.model) === modelValue,
      )
    )
      return;
    const model = modelOptions[0];
    setModelValue(model ? modelOptionValue(model.provider, model.model) : '');
  }, [modelOptions, modelValue]);
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
    if (!initialPrompt || mutation.isPending) return;
    setError(undefined);
    setSharedWarning(false);
    try {
      const selectedModel = modelOptions.find(
        (model) => modelOptionValue(model.provider, model.model) === modelValue,
      );
      const result = await mutation.mutateAsync(
        newChatRequest(
          workspaceId,
          initialPrompt,
          acknowledge,
          selectedModel && {
            provider: selectedModel.provider,
            model: selectedModel.model,
          },
        ),
      );
      go(pendingChatPath(workspaceId, result.runtimeId));
    } catch (cause) {
      const details = errorDetails(cause);
      setError(details.message);
      setSharedWarning(
        isSharedWorkingDirectoryWarning(details.message, details.code),
      );
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
            className="composer new-chat-composer"
            aria-label="Start a new chat"
            onSubmit={(event) => void submit(event)}
          >
            <textarea
              aria-label="Message"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Message Pi…"
              rows={3}
              disabled={mutation.isPending}
            />
            <div className="new-chat-composer-actions">
              {modelOptions.length > 0 && (
                <label>
                  <span>Model</span>
                  <select
                    aria-label="Model"
                    value={modelValue}
                    disabled={mutation.isPending}
                    onChange={(event) => setModelValue(event.target.value)}
                  >
                    {modelOptions.map((model) => {
                      const value = modelOptionValue(
                        model.provider,
                        model.model,
                      );
                      return (
                        <option key={value} value={value}>
                          {model.name ?? value}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}
              <button
                type="submit"
                className="composer-send"
                disabled={mutation.isPending || !text.trim()}
                aria-label="Send first message"
              >
                <span aria-hidden="true">↑</span>
              </button>
            </div>
            {error && (
              <div className="new-chat-error" role="alert">
                <p className="error">{error}</p>
                {sharedWarning && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={mutation.isPending}
                    onClick={(event) => void submit(event, true)}
                  >
                    Continue
                  </button>
                )}
              </div>
            )}
          </form>
        </div>
      </section>
    </div>
  );
}
