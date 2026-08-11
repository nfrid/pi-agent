import {
  createThreadMutationOptions,
  dashboardHttpClient,
  invalidateDashboardQueries,
} from '@pi-dashboard/client';
import type { BrowserSnapshot, ProjectSummary } from '@pi-dashboard/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useDashboardNavigate } from '../navigation';
import { Rail } from './rail';

type CheckoutIsolation = 'worktree' | 'main';

export function projectDefaultIsolation(
  project: Pick<ProjectSummary, 'defaultIsolation'> | undefined,
): CheckoutIsolation {
  return project?.defaultIsolation ?? 'worktree';
}

export function shouldSyncProjectIsolation(
  source: { projectId: string; isolation: CheckoutIsolation },
  projectId: string,
  projectIsolation: CheckoutIsolation,
): boolean {
  return (
    source.projectId !== projectId || source.isolation !== projectIsolation
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
  const projectIsolation = projectDefaultIsolation(project);
  const [isolation, setIsolation] =
    useState<CheckoutIsolation>(projectIsolation);
  const isolationSourceRef = useRef({ projectId, isolation: projectIsolation });
  useEffect(() => {
    const source = isolationSourceRef.current;
    if (shouldSyncProjectIsolation(source, projectId, projectIsolation))
      setIsolation(projectIsolation);
    isolationSourceRef.current = { projectId, isolation: projectIsolation };
  }, [projectId, projectIsolation]);
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
