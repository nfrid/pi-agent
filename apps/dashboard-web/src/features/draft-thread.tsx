import type { MDXEditorMethods } from '@mdxeditor/editor';
import {
  createThreadMutationOptions,
  dashboardHttpClient,
  retryThreadMutationOptions,
} from '@pi-dashboard/client';
import type {
  BrowserSnapshot,
  ModelSelection,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useDashboardNavigate } from '../routes/navigation';
import { errorMessage } from '../shared/lib/error-message';
import { AgentThreadNav } from './agent-thread-nav';
import { useImageAttachments } from './composer/attachments';
import {
  ComposerModelControl,
  ComposerThinkingControl,
} from './composer/controls';
import { useComposerDraft } from './composer/draft';
import { ComposerShell } from './composer/shell';
import {
  beginDraftRetry,
  deleteDraft,
  draftPromotionCommandId,
  markDraftPromoted,
  readDrafts,
  setDraftModel,
  updateDraft,
  useDrafts,
} from './drafts';
import {
  configuredModelOptions,
  modelOptionValue,
  parseModelOptionValue,
} from './model-option';
import { latestRunForThread, threadTitle } from './project-new-thread';
import { useSessionNavigation } from './session-navigation-context';

export function draftModelSelection(
  runtimes: readonly RuntimeSnapshot[],
  selected?: ModelSelection,
): ModelSelection | undefined {
  const models = configuredModelOptions(runtimes);
  const available = new Set(
    models.map((model) => modelOptionValue(model.provider, model.model)),
  );
  if (
    selected &&
    available.has(modelOptionValue(selected.provider, selected.model))
  )
    return selected;
  const current = runtimes.find(
    (runtime) =>
      runtime.model &&
      available.has(
        modelOptionValue(runtime.model.provider, runtime.model.model),
      ),
  )?.model;
  if (current)
    return {
      provider: current.provider,
      model: current.model,
      ...(current.thinking ? { thinking: current.thinking } : {}),
    };
  const first = models[0];
  return first ? { provider: first.provider, model: first.model } : undefined;
}

export function draftThinkingLevels(
  runtimes: readonly RuntimeSnapshot[],
  selected?: ModelSelection,
): string[] {
  return [
    ...new Set([
      ...runtimes.flatMap((runtime) => runtime.thinkingLevels ?? []),
      ...(selected?.thinking ? [selected.thinking] : []),
    ]),
  ];
}

export function DraftThreadView({
  draftId,
  snapshot,
}: {
  draftId: string;
  snapshot: BrowserSnapshot;
}) {
  const drafts = useDrafts();
  const draft = drafts.find((candidate) => candidate.id === draftId);
  const fallbackDraft =
    draft ?? readDrafts().find((candidate) => candidate.id === draftId);
  const project = snapshot.projects?.find(
    (candidate) => candidate.id === fallbackDraft?.projectId,
  );
  const go = useDashboardNavigate();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const sessionNavigation = useSessionNavigation();
  const [localAgentNavOpen, setLocalAgentNavOpen] = useState(false);
  const agentNavOpen = sessionNavigation?.open ?? localAgentNavOpen;
  const setAgentNavOpen = sessionNavigation?.setOpen ?? setLocalAgentNavOpen;
  const editorRef = useRef<MDXEditorMethods>(null);
  const createMutation = useMutation(
    createThreadMutationOptions(dashboardHttpClient),
  );
  const retryMutation = useMutation(
    retryThreadMutationOptions(dashboardHttpClient),
  );
  const { initialDraft, text, updateText, clearDraft } =
    useComposerDraft(draftId);
  const attachments = useImageAttachments({
    enabled: false,
    busy: submitting,
    onError: setError,
  });
  const modelOptions = configuredModelOptions(snapshot.runtimes);
  const selectedModel = draftModelSelection(
    snapshot.runtimes,
    fallbackDraft?.model,
  );
  const thinkingLevels = draftThinkingLevels(snapshot.runtimes, selectedModel);
  const promotedThreadId = fallbackDraft?.promotedThreadId;
  const pendingRun = promotedThreadId
    ? latestRunForThread(snapshot.runs ?? [], promotedThreadId)
    : undefined;
  const pendingRuntime = pendingRun?.runtimeId
    ? snapshot.runtimes.find(
        (runtime) => runtime.runtimeId === pendingRun.runtimeId,
      )
    : undefined;
  const starting =
    submitting ||
    (Boolean(promotedThreadId) &&
      pendingRun?.status !== 'failed' &&
      pendingRun?.status !== 'interrupted' &&
      !pendingRuntime);

  useEffect(() => {
    if (text !== initialDraft) updateDraft(draftId, threadTitle(text));
  }, [draftId, initialDraft, text]);

  useEffect(() => {
    const sessionId = pendingRuntime?.session.id;
    if (!sessionId) return;
    clearDraft();
    deleteDraft(draftId);
    go(`/sessions/${encodeURIComponent(sessionId)}`, { replace: true });
  }, [clearDraft, draftId, go, pendingRuntime?.session.id]);

  useEffect(() => {
    if (pendingRun?.status !== 'failed' && pendingRun?.status !== 'interrupted')
      return;
    setSubmitting(false);
    setError(
      pendingRun.error ??
        (pendingRun.status === 'interrupted'
          ? 'The run was interrupted before its runtime started.'
          : 'The run failed before its runtime started.'),
    );
  }, [pendingRun?.error, pendingRun?.status]);

  if (!fallbackDraft || !project) {
    return (
      <div
        className={
          sessionNavigation ? 'session-route-content' : 'session-layout'
        }
      >
        {!sessionNavigation && (
          <AgentThreadNav
            snapshot={snapshot}
            mode="session"
            open={agentNavOpen}
            onOpenChange={setAgentNavOpen}
          />
        )}
        <section className={`session-page${agentNavOpen ? ' modal-open' : ''}`}>
          <div className="draft-empty-transcript" aria-live="polite">
            <p className="eyebrow">Draft deleted</p>
            <p>Select a thread or start a new one.</p>
          </div>
        </section>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = text.trim();
    if (
      !prompt ||
      submitting ||
      createMutation.isPending ||
      retryMutation.isPending
    )
      return;
    setError(undefined);
    setSubmitting(true);
    try {
      const liveDraft =
        readDrafts().find((candidate) => candidate.id === draftId) ??
        fallbackDraft;
      const submissionModel = draftModelSelection(
        snapshot.runtimes,
        liveDraft.model,
      );
      if (liveDraft.promotedThreadId) {
        const retry = beginDraftRetry(draftId);
        if (!retry)
          throw new Error('The promoted draft is no longer available.');
        await retryMutation.mutateAsync({
          threadId: retry.threadId,
          command: {
            commandId: retry.commandId,
            prompt,
            ...(submissionModel ? { model: submissionModel } : {}),
          },
        });
        return;
      }
      const result = await createMutation.mutateAsync({
        projectId: liveDraft.projectId,
        command: {
          commandId: draftPromotionCommandId(draftId),
          title: threadTitle(prompt),
          prompt,
          isolation: liveDraft.isolation,
          ...(submissionModel ? { model: submissionModel } : {}),
        },
      });
      markDraftPromoted(draftId, result.thread.id);
    } catch (cause) {
      setError(errorMessage(cause));
      setSubmitting(false);
    }
  };

  return (
    <div
      className={sessionNavigation ? 'session-route-content' : 'session-layout'}
    >
      {!sessionNavigation && (
        <AgentThreadNav
          snapshot={snapshot}
          mode="session"
          currentDraftId={fallbackDraft.id}
          open={agentNavOpen}
          onOpenChange={setAgentNavOpen}
        />
      )}
      <section className={`session-page${agentNavOpen ? ' modal-open' : ''}`}>
        <div className="session-context-slot">
          <header className="session-context session-heading">
            <div className="session-context-main">
              <div className="session-identity">
                <div className="session-breadcrumb">
                  <span className="session-workspace">{project.title}</span>
                  <span
                    className="session-breadcrumb-separator"
                    aria-hidden="true"
                  >
                    /
                  </span>
                  <h1>New thread</h1>
                </div>
                <span
                  className={`session-status ${starting ? 'status-waiting' : 'status-draft'}`}
                  aria-live="polite"
                >
                  <i aria-hidden="true">{starting ? '◐' : '●'}</i>{' '}
                  {starting ? 'starting' : 'draft'}
                </span>
              </div>
            </div>
          </header>
        </div>
        <section className="session-transcript-scroll" aria-label="Transcript">
          <div className="draft-empty-transcript">
            <p className="eyebrow">New conversation</p>
            <p>Send a message to start this project thread.</p>
          </div>
        </section>
        <div className="session-control-layer">
          <ComposerShell
            ariaLabel="Send a message"
            onSubmit={(event) => void submit(event)}
            dragging={attachments.dragging}
            onDragEnter={attachments.onDragEnter}
            onDragOver={attachments.onDragOver}
            onDragLeave={attachments.onDragLeave}
            onDrop={attachments.onDrop}
            attachmentsEnabled={false}
            attachmentsBusy={submitting}
            fileInputRef={attachments.fileInputRef}
            attachments={attachments.attachments}
            onSelectImages={attachments.selectImages}
            onRemoveImage={attachments.removeImage}
            onPasteCapture={attachments.onPasteCapture}
            editorRef={editorRef}
            initialMarkdown={initialDraft}
            onChange={updateText}
            placeholder="Message Pi…"
            readOnly={submitting}
            submissionDisabled={submitting}
            sendDisabled={submitting || !text.trim()}
            sendAriaLabel="Send message"
            mode={<span>Prompt</span>}
            controls={
              <>
                <ComposerModelControl
                  models={modelOptions}
                  value={
                    selectedModel
                      ? modelOptionValue(
                          selectedModel.provider,
                          selectedModel.model,
                        )
                      : ''
                  }
                  disabled={submitting}
                  onChange={(value) => {
                    const model = parseModelOptionValue(value);
                    if (!model) return;
                    setDraftModel(draftId, {
                      ...model,
                      ...(selectedModel?.thinking
                        ? { thinking: selectedModel.thinking }
                        : {}),
                    });
                  }}
                />
                <ComposerThinkingControl
                  levels={thinkingLevels}
                  value={selectedModel?.thinking ?? thinkingLevels[0] ?? ''}
                  disabled={submitting || !selectedModel}
                  onChange={(thinking) => {
                    if (!selectedModel) return;
                    setDraftModel(draftId, { ...selectedModel, thinking });
                  }}
                />
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
        </div>
      </section>
    </div>
  );
}
