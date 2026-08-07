import type { DashboardLiveStore } from '@pi-dashboard/client';
import {
  adoptProjectMutationOptions,
  adoptSessionMutationOptions,
  archiveThreadMutationOptions,
  cancelRunMutationOptions,
  createThreadMutationOptions,
  dashboardHttpClient,
  invalidateDashboardQueries,
  mergeCheckoutMutationOptions,
  retireCheckoutMutationOptions,
  retryThreadMutationOptions,
  reviewCheckoutMutationOptions,
} from '@pi-dashboard/client';
import type {
  BrowserSnapshot,
  CheckoutSummary,
  ProjectSummary,
  RunSummary,
  SessionIndexEntry,
  ThreadSummary,
} from '@pi-dashboard/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Composer } from '../features/composer';
import { SessionView } from '../features/session';
import { useDashboardNavigate } from './navigation';

export type ThreadShelf =
  | 'pinned'
  | 'attention'
  | 'running'
  | 'queued'
  | 'recent'
  | 'archived';

const activeRunStatuses = new Set([
  'queued',
  'preparing',
  'starting',
  'running',
  'waiting',
]);
const settledRunStatuses = new Set(['settled', 'cancelled', 'interrupted']);

/** Pure, stable management projection. A thread appears in exactly one shelf. */
export function groupThreads(
  threads: readonly ThreadSummary[],
  runs: readonly RunSummary[],
): Record<ThreadShelf, readonly ThreadSummary[]> {
  const latest = new Map<string, RunSummary>();
  for (const run of [...runs].sort(
    (a, b) =>
      b.attempt - a.attempt ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  )) {
    if (!latest.has(run.threadId)) latest.set(run.threadId, run);
  }
  const shelves: Record<ThreadShelf, ThreadSummary[]> = {
    pinned: [],
    attention: [],
    running: [],
    queued: [],
    recent: [],
    archived: [],
  };
  const sorted = [...threads].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
  for (const thread of sorted) {
    const run = latest.get(thread.id);
    const status = run?.status ?? thread.status;
    const shelf: ThreadShelf =
      thread.status === 'archived'
        ? 'archived'
        : thread.pinnedAt !== undefined
          ? 'pinned'
          : status === 'needs-input' || status === 'failed'
            ? 'attention'
            : status === 'running' ||
                status === 'waiting' ||
                status === 'preparing' ||
                status === 'starting'
              ? 'running'
              : status === 'queued'
                ? 'queued'
                : 'recent';
    shelves[shelf].push(thread);
  }
  return shelves;
}

function when(value: number | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString([], {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}
function runFor(
  thread: ThreadSummary,
  runs: readonly RunSummary[],
): RunSummary | undefined {
  return [...runs]
    .filter((run) => run.threadId === thread.id)
    .sort((a, b) => b.attempt - a.attempt || b.createdAt - a.createdAt)[0];
}
function checkoutFor(
  thread: ThreadSummary,
  checkouts: readonly CheckoutSummary[],
): CheckoutSummary | undefined {
  return thread.checkoutId
    ? checkouts.find((checkout) => checkout.id === thread.checkoutId)
    : undefined;
}
function errorText(run: RunSummary | undefined): string | undefined {
  return run?.error;
}

export function managementStatusCounts(
  snapshot: Pick<BrowserSnapshot, 'threads' | 'runs'>,
): {
  active: number;
  queued: number;
  attention: number;
  failed: number;
  interrupted: number;
} {
  const runs = snapshot.runs ?? [];
  return {
    active: runs.filter(
      (run) => activeRunStatuses.has(run.status) && run.status !== 'queued',
    ).length,
    queued: runs.filter((run) => run.status === 'queued').length,
    attention: (snapshot.threads ?? []).filter(
      (thread) => thread.status === 'needs-input' || thread.status === 'failed',
    ).length,
    failed: runs.filter((run) => run.status === 'failed').length,
    interrupted: runs.filter((run) => run.status === 'interrupted').length,
  };
}

export function runTiming(
  run: Pick<RunSummary, 'createdAt' | 'startedAt' | 'finishedAt'>,
  now = Date.now(),
): string {
  if (run.finishedAt !== undefined) return `Settled ${when(run.finishedAt)}`;
  const start = run.startedAt ?? run.createdAt;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return `${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`} elapsed`;
}

export function sessionRouteTarget(
  sessionId: string,
  runs: readonly RunSummary[],
): string | undefined {
  const run = runs.find((candidate) => candidate.piSessionId === sessionId);
  return run ? `/threads/${encodeURIComponent(run.threadId)}` : undefined;
}

function Rail({
  snapshot,
  activeProjectId,
}: {
  snapshot: BrowserSnapshot;
  activeProjectId?: string;
}) {
  const go = useDashboardNavigate();
  const [open, setOpen] = useState(false);
  const projects = snapshot.projects ?? [];
  const active = (snapshot.runs ?? []).filter(
    (run) => activeRunStatuses.has(run.status) && run.status !== 'queued',
  ).length;
  const attention = (snapshot.threads ?? []).filter(
    (thread) => thread.status === 'needs-input' || thread.status === 'failed',
  ).length;
  return (
    <>
      <button
        type="button"
        className="management-drawer-toggle"
        aria-label="Open project rail"
        onClick={() => setOpen(true)}
      >
        ☰ Projects
      </button>
      <aside
        className={`project-rail ${open ? 'is-open' : ''}`}
        aria-label="Projects"
      >
        <div className="project-rail-heading">
          <strong>Projects</strong>
          <button
            type="button"
            aria-label="Close project rail"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <button
          type="button"
          className="rail-attention"
          onClick={() => go('/')}
        >
          <span>Needs attention</span>
          <b>{attention}</b>
        </button>
        <p className="rail-counts">
          {active} active ·{' '}
          {
            (snapshot.runs ?? []).filter((run) => run.status === 'queued')
              .length
          }{' '}
          queued
        </p>
        {projects.map((project) => (
          <button
            type="button"
            key={project.id}
            className={`project-rail-item ${project.id === activeProjectId ? 'active' : ''}`}
            onClick={() => {
              setOpen(false);
              go(`/projects/${encodeURIComponent(project.id)}`);
            }}
          >
            <span>{project.title}</span>
            <small>
              {
                (snapshot.runs ?? []).filter(
                  (run) =>
                    run.status !== 'queued' &&
                    activeRunStatuses.has(run.status) &&
                    snapshot.threads?.find(
                      (thread) => thread.id === run.threadId,
                    )?.projectId === project.id,
                ).length
              }
              /{project.maxParallelRuns}
            </small>
          </button>
        ))}
        <button
          type="button"
          className="project-rail-new"
          onClick={() => {
            setOpen(false);
            go('/projects');
          }}
        >
          + Adopt project
        </button>
      </aside>
      {open && (
        <button
          type="button"
          className="project-rail-backdrop"
          aria-label="Close project rail"
          onClick={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ThreadCard({
  thread,
  runs,
  checkouts,
}: {
  thread: ThreadSummary;
  runs: readonly RunSummary[];
  checkouts: readonly CheckoutSummary[];
}) {
  const go = useDashboardNavigate();
  const run = runFor(thread, runs);
  const checkout = checkoutFor(thread, checkouts);
  return (
    <article className="management-thread-card">
      <button
        type="button"
        className="thread-card-link"
        onClick={() => go(`/threads/${encodeURIComponent(thread.id)}`)}
      >
        <h3>{thread.title}</h3>
        <p className="thread-card-meta">
          {checkout?.branch ?? checkout?.kind ?? 'No checkout'} ·{' '}
          {run?.status ?? thread.status}
        </p>
        <p className="thread-card-meta">
          {run?.model
            ? `${run.model.provider}/${run.model.model}${run.model.thinking ? ` · thinking ${run.model.thinking}` : ''}`
            : 'Model default'}{' '}
          · {when(thread.updatedAt)}
        </p>
        {errorText(run) && <p className="error">{errorText(run)}</p>}
        <p className="thread-card-meta">
          {run ? runTiming(run) : 'Queued'}
          {checkout?.changedFileCount !== undefined
            ? ` · ${checkout.changedFileCount} changed files`
            : ''}
        </p>
      </button>
    </article>
  );
}

export function ProjectShelves({
  project,
  snapshot,
}: {
  project: ProjectSummary;
  snapshot: BrowserSnapshot;
}) {
  const threads = (snapshot.threads ?? []).filter(
    (thread) => thread.projectId === project.id,
  );
  const runs = snapshot.runs ?? [];
  const checkouts = snapshot.checkouts ?? [];
  const shelves = groupThreads(threads, runs);
  const labels: Record<ThreadShelf, string> = {
    pinned: 'Pinned',
    attention: 'Needs attention',
    running: 'Running',
    queued: 'Queued',
    recent: 'Recent',
    archived: 'Archived',
  };
  return (
    <div className="management-shelves">
      {(Object.keys(labels) as ThreadShelf[]).map((shelf) => (
        <section className="management-shelf" key={shelf}>
          <h2>
            {labels[shelf]}{' '}
            <span className="shelf-count">{shelves[shelf].length}</span>
          </h2>
          {shelves[shelf].length ? (
            <div className="thread-card-grid">
              {shelves[shelf].map((thread) => (
                <ThreadCard
                  key={thread.id}
                  thread={thread}
                  runs={runs}
                  checkouts={checkouts}
                />
              ))}
            </div>
          ) : (
            <p className="empty-shelf">Nothing here.</p>
          )}
        </section>
      ))}
    </div>
  );
}

export function ProjectsRoute({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    ...adoptProjectMutationOptions(dashboardHttpClient),
    onSuccess: async (result) => {
      await invalidateDashboardQueries(queryClient);
      go(`/projects/${encodeURIComponent(result.project.id)}`);
    },
  });
  const [workspaceId, setWorkspaceId] = useState(
    snapshot.workspaces[0]?.id ?? '',
  );
  const [title, setTitle] = useState('');
  const [isolation, setIsolation] = useState<'worktree' | 'main'>('worktree');
  const [maxParallelRuns, setMaxParallelRuns] = useState('1');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId) return;
    mutation.mutate({
      workspaceId,
      ...(title.trim() ? { title: title.trim() } : {}),
      defaultIsolation: isolation,
      maxParallelRuns: Math.max(1, Number(maxParallelRuns) || 1),
    });
  };
  return (
    <>
      <Rail snapshot={snapshot} />
      <section className="management-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Management</p>
            <h1>Projects</h1>
          </div>
          <button type="button" onClick={() => go('/')}>
            Dashboard
          </button>
        </div>
        <form className="management-form" onSubmit={submit}>
          <h2>Adopt a workspace</h2>
          <label>
            Workspace
            <select
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              {snapshot.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name} · {workspace.canonicalPath}
                </option>
              ))}
            </select>
          </label>
          <label>
            Project title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Defaults to workspace name"
            />
          </label>
          <label>
            Default isolation
            <select
              value={isolation}
              onChange={(event) =>
                setIsolation(event.target.value as 'worktree' | 'main')
              }
            >
              <option value="worktree">Worktree</option>
              <option value="main">Main checkout</option>
            </select>
          </label>
          <label>
            Max parallel runs
            <input
              type="number"
              min="1"
              value={maxParallelRuns}
              onChange={(event) => setMaxParallelRuns(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!workspaceId || mutation.isPending}>
            {mutation.isPending ? 'Adopting…' : 'Adopt project'}
          </button>
          {mutation.error && <p className="error">{String(mutation.error)}</p>}
        </form>
        {(snapshot.projects ?? []).length === 0 && (
          <p className="empty-state">
            No projects yet. Adopt an existing workspace to start durable queued
            work.
          </p>
        )}
        {(snapshot.projects ?? []).map((project) => (
          <button
            type="button"
            className="project-list-row"
            key={project.id}
            onClick={() => go(`/projects/${encodeURIComponent(project.id)}`)}
          >
            <strong>{project.title}</strong>
            <span>
              {project.activeRunCount} active · max {project.maxParallelRuns}
            </span>
            <small>{project.rootPath}</small>
          </button>
        ))}
      </section>
    </>
  );
}

export function ProjectRoute({
  projectId,
  snapshot,
}: {
  projectId: string;
  snapshot: BrowserSnapshot;
}) {
  const project = snapshot.projects?.find((item) => item.id === projectId);
  const go = useDashboardNavigate();
  if (!project)
    return (
      <section className="management-page">
        <h1>Project not found</h1>
        <button type="button" onClick={() => go('/projects')}>
          Projects
        </button>
      </section>
    );
  return (
    <>
      <Rail snapshot={snapshot} activeProjectId={project.id} />
      <section className="management-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Project</p>
            <h1>{project.title}</h1>
            <p className="path-label">{project.rootPath}</p>
          </div>
          <button
            type="button"
            onClick={() =>
              go(`/projects/${encodeURIComponent(project.id)}/new`)
            }
          >
            + New thread
          </button>
        </div>
        <p className="management-summary">
          {
            (snapshot.runs ?? []).filter(
              (run) =>
                run.status !== 'queued' &&
                activeRunStatuses.has(run.status) &&
                snapshot.threads?.find((thread) => thread.id === run.threadId)
                  ?.projectId === project.id,
            ).length
          }{' '}
          active ·{' '}
          {
            (snapshot.runs ?? []).filter(
              (run) =>
                run.status === 'queued' &&
                snapshot.threads?.find((thread) => thread.id === run.threadId)
                  ?.projectId === project.id,
            ).length
          }{' '}
          queued · max {project.maxParallelRuns} parallel runs · attention{' '}
          {
            (snapshot.threads ?? []).filter(
              (thread) =>
                thread.projectId === project.id &&
                (thread.status === 'needs-input' || thread.status === 'failed'),
            ).length
          }
        </p>
        <ProjectShelves project={project} snapshot={snapshot} />
        <LegacySessions project={project} snapshot={snapshot} />
      </section>
    </>
  );
}

function LegacySessions({
  project,
  snapshot,
}: {
  project: ProjectSummary;
  snapshot: BrowserSnapshot;
}) {
  const queryClient = useQueryClient();
  const go = useDashboardNavigate();
  const mutation = useMutation({
    ...adoptSessionMutationOptions(dashboardHttpClient),
    onSuccess: async (result) => {
      await invalidateDashboardQueries(queryClient);
      go(`/threads/${encodeURIComponent(result.thread.id)}`);
    },
  });
  const checkouts = (snapshot.checkouts ?? []).filter(
    (checkout) =>
      checkout.projectId === project.id &&
      (checkout.status === 'ready' || checkout.status === 'dirty'),
  );
  const owned = new Set(
    (snapshot.runs ?? []).map((run) => run.piSessionId).filter(Boolean),
  );
  const sessions = snapshot.sessions.filter(
    (session) =>
      !owned.has(session.id) &&
      checkouts.some(
        (checkout) =>
          session.cwd === checkout.path ||
          session.cwd.startsWith(`${checkout.path}/`),
      ),
  );
  if (!sessions.length) return null;
  return (
    <section className="legacy-sessions">
      <h2>Unassigned Pi sessions</h2>
      <p>These legacy sessions are not owned by a thread.</p>
      {sessions.map((session) => (
        <div className="legacy-session-row" key={session.id}>
          <span className="legacy-session-info">
            <strong>{session.title ?? session.name ?? session.id}</strong>
            <small>{session.cwd}</small>
          </span>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({ projectId: project.id, sessionId: session.id })
            }
          >
            Adopt as thread
          </button>
        </div>
      ))}
    </section>
  );
}

export function NewThreadRoute({
  projectId,
  snapshot,
}: {
  projectId: string;
  snapshot: BrowserSnapshot;
}) {
  const project = snapshot.projects?.find((item) => item.id === projectId);
  const go = useDashboardNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    ...createThreadMutationOptions(dashboardHttpClient),
    onSuccess: async (result) => {
      await invalidateDashboardQueries(queryClient);
      go(`/threads/${encodeURIComponent(result.thread.id)}`);
    },
  });
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isolation, setIsolation] = useState<'worktree' | 'main'>(
    project?.rootPath ? 'worktree' : 'worktree',
  );
  const [mode, setMode] = useState<'read' | 'write'>('write');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  if (!project)
    return (
      <section className="management-page">
        <h1>Project not found</h1>
      </section>
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !prompt.trim()) return;
    const modelValue =
      provider.trim() && model.trim()
        ? {
            provider: provider.trim(),
            model: model.trim(),
            ...(thinking.trim() ? { thinking: thinking.trim() } : {}),
          }
        : undefined;
    mutation.mutate({
      projectId,
      command: {
        title: title.trim(),
        prompt,
        isolation,
        mode,
        ...(modelValue ? { model: modelValue } : {}),
      },
    });
  };
  return (
    <>
      <Rail snapshot={snapshot} activeProjectId={project.id} />
      <section className="management-page">
        <button
          type="button"
          className="back"
          onClick={() => go(`/projects/${encodeURIComponent(project.id)}`)}
        >
          ← {project.title}
        </button>
        <h1>New thread</h1>
        <p className="queued-note">
          Runs are durable and always queued asynchronously after submission.
        </p>
        <form className="management-form" onSubmit={submit}>
          <label>
            Title
            <input
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Complete prompt
            <textarea
              required
              rows={8}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Checkout</legend>
            <label>
              <input
                type="radio"
                checked={isolation === 'worktree'}
                onChange={() => setIsolation('worktree')}
              />{' '}
              Worktree (default)
            </label>
            <label>
              <input
                type="radio"
                checked={isolation === 'main'}
                onChange={() => setIsolation('main')}
              />{' '}
              Main
            </label>
          </fieldset>
          <fieldset>
            <legend>Access</legend>
            <label>
              <input
                type="radio"
                checked={mode === 'write'}
                onChange={() => setMode('write')}
              />{' '}
              Read/write
            </label>
            <label>
              <input
                type="radio"
                checked={mode === 'read'}
                onChange={() => setMode('read')}
              />{' '}
              Read-only
            </label>
          </fieldset>
          <div className="form-grid">
            <label>
              Provider (optional)
              <input
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              />
            </label>
            <label>
              Model (optional)
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <label>
              Thinking (optional)
              <input
                value={thinking}
                onChange={(event) => setThinking(event.target.value)}
              />
            </label>
          </div>
          <button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Queueing…' : 'Queue thread'}
          </button>
          {mutation.error && <p className="error">{String(mutation.error)}</p>}
        </form>
      </section>
    </>
  );
}

export function ThreadRoute({
  threadId,
  snapshot,
  store,
}: {
  threadId: string;
  snapshot: BrowserSnapshot;
  store: DashboardLiveStore;
}) {
  const thread = snapshot.threads?.find((item) => item.id === threadId);
  const go = useDashboardNavigate();
  const queryClient = useQueryClient();
  const runs = (snapshot.runs ?? [])
    .filter((run) => run.threadId === threadId)
    .sort((a, b) => b.attempt - a.attempt || b.createdAt - a.createdAt);
  const selected = runs[0];
  const checkout = selected
    ? snapshot.checkouts?.find((item) => item.id === selected.checkoutId)
    : undefined;
  const [feedback, setFeedback] = useState<string>();
  const [review, setReview] = useState<unknown>();
  const refresh = async () => invalidateDashboardQueries(queryClient);
  const cancel = useMutation({
    ...cancelRunMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Cancellation requested.');
      await refresh();
    },
  });
  const retry = useMutation({
    ...retryThreadMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Retry queued.');
      await refresh();
    },
  });
  const archive = useMutation({
    ...archiveThreadMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Thread archived.');
      await refresh();
    },
  });
  const reviewMutation = useMutation({
    ...reviewCheckoutMutationOptions(dashboardHttpClient),
    onSuccess: (result) => setReview(result),
  });
  const merge = useMutation({
    ...mergeCheckoutMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Checkout merged.');
      await refresh();
    },
  });
  const retire = useMutation({
    ...retireCheckoutMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Checkout retired.');
      await refresh();
    },
  });
  if (!thread)
    return (
      <section className="management-page">
        <h1>Thread not found</h1>
        <button type="button" onClick={() => go('/')}>
          Dashboard
        </button>
      </section>
    );
  const active = Boolean(selected && activeRunStatuses.has(selected.status));
  const busy =
    cancel.isPending ||
    retry.isPending ||
    archive.isPending ||
    merge.isPending ||
    retire.isPending;
  const actionError =
    cancel.error ??
    retry.error ??
    archive.error ??
    merge.error ??
    retire.error ??
    reviewMutation.error;
  const confirmAction = (message: string, action: () => void) => {
    if (globalThis.confirm(message)) action();
  };
  const sessionId = selected?.piSessionId;
  const reviewRecord =
    review && typeof review === 'object' && !Array.isArray(review)
      ? (review as {
          state?: string;
          stat?: string;
          diff?: string;
          pathSummary?: {
            total?: number;
            matchedPaths?: string[];
          };
        })
      : undefined;
  return (
    <>
      <Rail snapshot={snapshot} activeProjectId={thread.projectId} />
      <section className="management-page thread-detail">
        <button
          type="button"
          className="back"
          onClick={() =>
            go(`/projects/${encodeURIComponent(thread.projectId)}`)
          }
        >
          ← Project
        </button>
        <div className="page-heading">
          <div>
            <p className="eyebrow">Thread</p>
            <h1>{thread.title}</h1>
            <p className="path-label">
              {thread.status} · updated {when(thread.updatedAt)}
            </p>
          </div>
          <div className="action-row">
            <button
              type="button"
              disabled={!selected || !active || busy}
              onClick={() => selected && cancel.mutate({ runId: selected.id })}
            >
              Cancel run
            </button>
            <button
              type="button"
              disabled={!selected || active || busy}
              onClick={() => retry.mutate({ threadId })}
            >
              Retry
            </button>
            <button
              type="button"
              disabled={active || busy}
              onClick={() =>
                confirmAction('Archive this thread?', () =>
                  archive.mutate({ threadId }),
                )
              }
            >
              Archive
            </button>
          </div>
        </div>
        {feedback && (
          <p className="success" role="status">
            {feedback}
          </p>
        )}
        {actionError && (
          <p className="error" role="alert">
            {String(actionError)}
          </p>
        )}
        <section className="detail-panel">
          <h2>Run history</h2>
          {runs.length ? (
            runs.map((run) => (
              <article className="run-history-row" key={run.id}>
                <strong>Attempt {run.attempt}</strong>
                <span className="run-history-meta">{run.status}</span>
                <span className="run-history-meta">
                  created {when(run.createdAt)}
                </span>
                <span className="run-history-meta">
                  {run.startedAt ? `started ${when(run.startedAt)}` : ''}{' '}
                  {run.finishedAt ? `settled ${when(run.finishedAt)}` : ''}
                </span>
                {run.error && <p className="error run-error">{run.error}</p>}
              </article>
            ))
          ) : (
            <p>No attempts yet.</p>
          )}
        </section>
        <section className="detail-panel">
          <h2>Checkout</h2>
          {checkout ? (
            <>
              <p>
                {checkout.kind} · {checkout.status}
              </p>
              <p>
                {checkout.path}
                {checkout.branch ? ` · ${checkout.branch}` : ''}
                {checkout.changedFileCount !== undefined
                  ? ` · ${checkout.changedFileCount} changed files`
                  : ''}
              </p>
              <div className="action-row">
                <button
                  type="button"
                  disabled={reviewMutation.isPending}
                  onClick={() => reviewMutation.mutate(checkout.id)}
                >
                  Review checkout
                </button>
                <button
                  type="button"
                  disabled={active || busy}
                  onClick={() =>
                    confirmAction('Merge this checkout?', () =>
                      merge.mutate({ checkoutId: checkout.id }),
                    )
                  }
                >
                  Merge
                </button>
                <button
                  type="button"
                  disabled={active || busy}
                  onClick={() =>
                    confirmAction('Retire this checkout?', () =>
                      retire.mutate({ checkoutId: checkout.id }),
                    )
                  }
                >
                  Retire
                </button>
              </div>
              {reviewRecord && (
                <div className="bounded-review">
                  <p>
                    {reviewRecord.state ?? 'Review'} ·{' '}
                    {reviewRecord.pathSummary?.total ?? 0} changed paths
                  </p>
                  <p>
                    {reviewRecord.pathSummary?.matchedPaths?.join(', ') ||
                      'No changed paths reported.'}
                  </p>
                  <pre>{(reviewRecord.stat ?? '').slice(0, 5_000)}</pre>
                  <pre>{(reviewRecord.diff ?? '').slice(0, 15_000)}</pre>
                </div>
              )}
            </>
          ) : (
            <p>No checkout.</p>
          )}
        </section>
        {selected && (
          <section className="detail-panel">
            <h2>Runtime lineage</h2>
            <p>
              Provider: {selected.runtimeProvider} · runtime{' '}
              {selected.runtimeId ?? 'not started'} · Pi session{' '}
              {sessionId ?? 'not attached'}
            </p>
          </section>
        )}
        {sessionId && (
          <section className="detail-panel transcript-embed">
            <h2>Transcript</h2>
            <SessionView
              id={sessionId}
              snapshot={snapshot}
              store={store}
              Composer={Composer}
            />
          </section>
        )}
      </section>
    </>
  );
}

export function ManagementHome({
  snapshot,
}: {
  snapshot: BrowserSnapshot;
  store?: DashboardLiveStore;
}) {
  const projects = snapshot.projects ?? [];
  if (!projects.length)
    return (
      <section className="management-page">
        <h1>No projects</h1>
        <p>
          Use the existing dashboard runtime view, or adopt a workspace to
          enable management.
        </p>
      </section>
    );
  const project = projects[0];
  return <ProjectRoute projectId={project.id} snapshot={snapshot} />;
}

export function managementProjectCount(snapshot: BrowserSnapshot): number {
  return snapshot.projects?.length ?? 0;
}
export function unassignedSessions(
  snapshot: BrowserSnapshot,
  project: ProjectSummary,
): readonly SessionIndexEntry[] {
  const checkouts = (snapshot.checkouts ?? []).filter(
    (c) =>
      c.projectId === project.id &&
      (c.status === 'ready' || c.status === 'dirty'),
  );
  const owned = new Set(
    (snapshot.runs ?? []).map((run) => run.piSessionId).filter(Boolean),
  );
  return snapshot.sessions.filter(
    (s) =>
      !owned.has(s.id) &&
      checkouts.some((c) => s.cwd === c.path || s.cwd.startsWith(`${c.path}/`)),
  );
}
export function latestRunForThread(
  threadId: string,
  runs: readonly RunSummary[],
): RunSummary | undefined {
  return runs
    .filter((run) => run.threadId === threadId)
    .sort((a, b) => b.attempt - a.attempt || b.createdAt - a.createdAt)[0];
}
export function isTerminalRun(status: RunSummary['status']): boolean {
  return settledRunStatuses.has(status) || status === 'failed';
}
