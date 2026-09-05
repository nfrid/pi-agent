import type { MDXEditorMethods } from '@mdxeditor/editor';
import {
  composerCommandsQueryOptions,
  createThreadMutationOptions,
  dashboardHttpClient,
  draftDefaultsQueryOptions,
  retryThreadMutationOptions,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useDashboardNavigate } from '../routes/navigation';
import { errorMessage } from '../shared/lib/error-message';
import { AgentThreadNav } from './agent-thread-nav';
import { useImageAttachments } from './composer/attachments';
import { useComposerDraft } from './composer/draft';
import {
  DraftAgentPicker,
  DraftLocationPicker,
} from './composer/draft-pickers';
import { draftModelSupportsImages } from './composer/runtime';
import { ComposerShell } from './composer/shell';
import {
  beginDraftRetry,
  draftPromotionCommandId,
  markDraftPromoted,
  readDrafts,
  updateDraft,
  useDrafts,
} from './drafts';
import { draftModelSelection } from './model-option';
import { latestRunForThread, threadTitle } from './project-new-thread';
import { useSessionNavigation } from './session-navigation-context';

export { draftModelSelection } from './model-option';

type DraftStartupStatus =
  | 'queued'
  | 'preparing'
  | 'starting'
  | 'running'
  | 'waiting';

export function draftStartupState({
  submitting,
  promoted,
  runStatus,
  runtimeStarted,
  preparingWorktree,
}: {
  submitting: boolean;
  promoted: boolean;
  runStatus: string | undefined;
  runtimeStarted: boolean;
  preparingWorktree: boolean;
}): { heading: string; copy: string } | undefined {
  if (runtimeStarted || (!submitting && !promoted)) return undefined;
  const active = new Set<DraftStartupStatus>([
    'queued',
    'preparing',
    'starting',
    'running',
    'waiting',
  ]);
  if (
    !submitting &&
    (!runStatus || !active.has(runStatus as DraftStartupStatus))
  )
    return undefined;
  if (runStatus === 'queued')
    return {
      heading: 'Waiting to start',
      copy: 'Waiting for launch capacity…',
    };
  if (runStatus === 'preparing')
    return preparingWorktree
      ? {
          heading: 'Preparing worktree',
          copy: 'Creating the isolated checkout for this thread…',
        }
      : {
          heading: 'Preparing checkout',
          copy: 'Preparing the selected checkout…',
        };
  if (runStatus === 'starting')
    return {
      heading: 'Launching Pi',
      copy: 'Launching Pi runtime and waiting for connection…',
    };
  if (runStatus === 'running' || runStatus === 'waiting')
    return {
      heading: 'Starting thread',
      copy: 'Waiting for the runtime to connect…',
    };
  return { heading: 'Scheduling thread', copy: 'Scheduling thread…' };
}

function locationForDraft(draft: {
  isolation: 'worktree' | 'main';
  location?:
    | { kind: 'current' }
    | { kind: 'worktree'; base: 'work' | 'head' }
    | { kind: 'worktree'; base: 'branch'; baseRef: string }
    | { kind: 'checkout'; checkoutId: string };
}) {
  return (
    draft.location ??
    (draft.isolation === 'main'
      ? { kind: 'current' as const }
      : { kind: 'worktree' as const, base: 'work' as const })
  );
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
  const draftDefaults = useQuery(
    draftDefaultsQueryOptions(
      dashboardHttpClient,
      fallbackDraft?.projectId ?? '',
    ),
  );
  const inheritedModel = draftDefaults.data?.selection;
  const selectedModel = draftModelSelection(
    snapshot.runtimes,
    fallbackDraft?.model,
    inheritedModel,
  );
  const modelResolutionReady =
    fallbackDraft?.model !== undefined || draftDefaults.isSuccess;
  const attachments = useImageAttachments({
    enabled: draftModelSupportsImages(selectedModel, snapshot.runtimes),
    busy: submitting,
    onError: setError,
  });
  const selectedLocation = fallbackDraft
    ? locationForDraft(fallbackDraft)
    : { kind: 'current' as const };
  const composerCwd =
    selectedLocation.kind === 'checkout'
      ? snapshot.checkouts?.find(
          (checkout) => checkout.id === selectedLocation.checkoutId,
        )?.path
      : selectedLocation.kind === 'current'
        ? snapshot.checkouts?.find(
            (checkout) =>
              checkout.projectId === fallbackDraft?.projectId &&
              checkout.kind === 'main',
          )?.path
        : project?.rootPath;
  const composerCommands = useQuery(
    composerCommandsQueryOptions(dashboardHttpClient, composerCwd ?? ''),
  );
  const promotedThreadId = fallbackDraft?.promotedThreadId;
  const pendingRun = promotedThreadId
    ? latestRunForThread(snapshot.runs ?? [], promotedThreadId)
    : undefined;
  const pendingRuntime = pendingRun?.runtimeId
    ? snapshot.runtimes.find(
        (runtime) => runtime.runtimeId === pendingRun.runtimeId,
      )
    : undefined;
  const startup = draftStartupState({
    submitting,
    promoted: Boolean(promotedThreadId),
    runStatus: pendingRun?.status,
    runtimeStarted: Boolean(pendingRuntime),
    preparingWorktree: selectedLocation.kind === 'worktree',
  });

  useEffect(() => {
    if (text !== initialDraft) updateDraft(draftId, threadTitle(text));
  }, [draftId, initialDraft, text]);

  useEffect(() => {
    const sessionId = pendingRuntime?.session.id;
    if (!sessionId) return;
    clearDraft();
    go(`/sessions/${encodeURIComponent(sessionId)}`, { replace: true });
  }, [clearDraft, go, pendingRuntime?.session.id]);

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
      (!prompt && attachments.attachments.length === 0) ||
      submitting ||
      !modelResolutionReady ||
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
      // Pin the same inherited tuple shown by this render. This keeps launch
      // and image capability checks aligned if settings change mid-submit.
      const submissionModel = liveDraft.model ?? inheritedModel;
      const location = locationForDraft(liveDraft);
      if (
        !liveDraft.promotedThreadId &&
        location.kind === 'worktree' &&
        location.base === 'branch' &&
        !location.baseRef.trim()
      )
        throw new Error('Choose a branch before starting the worktree.');
      if (liveDraft.promotedThreadId) {
        const retry = beginDraftRetry(draftId);
        if (!retry)
          throw new Error('The promoted draft is no longer available.');
        const retryCommand = {
          commandId: retry.commandId,
          prompt,
          ...(submissionModel ? { model: submissionModel } : {}),
        };
        if (attachments.attachments.length > 0)
          await dashboardHttpClient.retryThreadWithImages(
            retry.threadId,
            retryCommand,
            attachments.attachments.map((attachment) => attachment.file),
          );
        else
          await retryMutation.mutateAsync({
            threadId: retry.threadId,
            command: retryCommand,
          });
        if (attachments.attachments.length > 0) attachments.clearAttachments();
        return;
      }
      const createCommand = {
        commandId: draftPromotionCommandId(draftId),
        title: threadTitle(prompt || 'Image attachment'),
        prompt,
        ...(location.kind === 'current'
          ? {
              ...(snapshot.checkouts?.find(
                (checkout) =>
                  checkout.projectId === liveDraft.projectId &&
                  checkout.kind === 'main',
              )?.id
                ? {
                    checkoutId: snapshot.checkouts.find(
                      (checkout) =>
                        checkout.projectId === liveDraft.projectId &&
                        checkout.kind === 'main',
                    )?.id,
                  }
                : { isolation: 'main' as const }),
            }
          : location.kind === 'checkout'
            ? { checkoutId: location.checkoutId }
            : {
                isolation: 'worktree' as const,
                ...(location.base === 'head'
                  ? { base: 'head' as const }
                  : location.base === 'work' && liveDraft.location
                    ? { base: 'work' as const }
                    : {}),
                ...(location.base === 'branch'
                  ? { baseRef: location.baseRef.trim() }
                  : {}),
              }),
        ...(submissionModel ? { model: submissionModel } : {}),
      };
      const result =
        attachments.attachments.length > 0
          ? await dashboardHttpClient.createThreadWithImages(
              liveDraft.projectId,
              createCommand,
              attachments.attachments.map((attachment) => attachment.file),
            )
          : await createMutation.mutateAsync({
              projectId: liveDraft.projectId,
              command: createCommand,
            });
      if (attachments.attachments.length > 0) attachments.clearAttachments();
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
                  className={`session-status ${startup ? 'status-waiting' : 'status-draft'}`}
                  aria-live="polite"
                >
                  <i aria-hidden="true">{startup ? '◐' : '●'}</i>{' '}
                  {startup ? 'starting' : 'draft'}
                </span>
              </div>
            </div>
          </header>
        </div>
        <section className="session-transcript-scroll" aria-label="Transcript">
          <div
            className="draft-empty-transcript"
            role={startup ? 'status' : undefined}
            aria-live={startup ? 'polite' : undefined}
            aria-atomic={startup ? 'true' : undefined}
          >
            {startup ? (
              <>
                <span
                  className="session-loading-indicator"
                  aria-hidden="true"
                />
                <p className="eyebrow">{startup.heading}</p>
                <p>{startup.copy}</p>
              </>
            ) : (
              <>
                <p className="eyebrow">New conversation</p>
                <p>Send a message to start this project thread.</p>
              </>
            )}
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
            attachmentsEnabled={draftModelSupportsImages(
              selectedModel,
              snapshot.runtimes,
            )}
            attachmentsBusy={submitting}
            fileInputRef={attachments.fileInputRef}
            attachments={attachments.attachments}
            onSelectImages={attachments.selectImages}
            onRemoveImage={attachments.removeImage}
            onPasteCapture={attachments.onPasteCapture}
            editorRef={editorRef}
            initialMarkdown={initialDraft}
            commands={composerCommands.data?.commands}
            cwd={composerCwd}
            onChange={updateText}
            placeholder="Message Pi…"
            readOnly={submitting}
            submissionDisabled={submitting}
            sendDisabled={
              submitting ||
              !modelResolutionReady ||
              (!text.trim() && !attachments.attachments.length)
            }
            sendAriaLabel="Send message"
            mode={
              <DraftLocationPicker
                draftId={draftId}
                location={selectedLocation}
                projectId={project.id}
                projectRoot={project.rootPath}
                checkouts={(snapshot.checkouts ?? []).filter(
                  (checkout) => checkout.projectId === project.id,
                )}
                disabled={submitting}
              />
            }
            controls={
              <DraftAgentPicker
                draftId={draftId}
                model={selectedModel}
                runtimes={snapshot.runtimes}
                disabled={submitting}
              />
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
