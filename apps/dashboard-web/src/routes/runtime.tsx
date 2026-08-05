import {
  dashboardHttpClient,
  startRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type {
  BrowserSnapshot,
  StartRuntimeRequest,
} from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { sessionDisplayTitle } from '../app-helpers';
import { Back } from './dashboard';

function useDashboardNavigate(): (path: string) => void {
  const navigate = useNavigate();
  return (path) => void navigate({ to: path });
}

export function RuntimeView({
  id,
  snapshot,
}: {
  id: string;
  snapshot: BrowserSnapshot;
}) {
  const go = useDashboardNavigate();
  const runtime = snapshot.runtimes.find((item) => item.runtimeId === id);
  return (
    <section>
      <Back />
      <h1>Runtime diagnostics</h1>
      {runtime ? (
        <div className="diagnostics">
          <p>
            Ownership: <strong>{runtime.ownership}</strong>
          </p>
          <p>PID: {runtime.pid}</p>
          <p>Bridge: {runtime.online === false ? 'offline' : 'connected'}</p>
          <p>Session: {runtime.session.id}</p>
          <p>tmux: {runtime.tmux?.displayTarget ?? 'not reported'}</p>
          <button
            type="button"
            onClick={() =>
              go(`/sessions/${encodeURIComponent(runtime.session.id)}`)
            }
          >
            Open session
          </button>
          <pre>{JSON.stringify(runtime, null, 2)}</pre>
        </div>
      ) : (
        <p>Unknown runtime.</p>
      )}
    </section>
  );
}

export function LaunchView({
  snapshot,
  store,
}: {
  snapshot: BrowserSnapshot;
  store: import('@pi-dashboard/client').DashboardLiveStore;
}) {
  const go = useDashboardNavigate();
  const mutation = useMutation(
    startRuntimeMutationOptions(dashboardHttpClient),
  );
  const [workspaceId, setWorkspaceId] = useState(
    snapshot.workspaces.find((item) => item.active)?.id ?? '',
  );
  const [sessionId, setSessionId] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const sessions = snapshot.sessions.filter(
    (session) => session.workspaceId === workspaceId,
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const request: StartRuntimeRequest = {
      workspaceId,
      ...(sessionId ? { sessionId } : {}),
      ...(name ? { name } : {}),
      ...(prompt ? { initialPrompt: prompt } : {}),
      acknowledgeSharedWorkingDirectory: ack,
    };
    const requestGeneration = store.getGeneration();
    try {
      const result = await mutation.mutateAsync(request);
      store.applyMutationResult(result, requestGeneration);
      go(`/runtimes/${result.runtimeId}`);
    } catch (cause) {
      const appError = cause as { message: string; code?: string };
      setError(appError.message);
      if (appError.code === 'shared-working-directory') setAck(false);
    }
  };
  return (
    <section>
      <Back />
      <p className="eyebrow">New runtime</p>
      <h1>Start an agent</h1>
      <form className="launch-form" onSubmit={(event) => void submit(event)}>
        <label>
          Workspace
          <select
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              setSessionId('');
            }}
          >
            {snapshot.workspaces.map((workspace) => (
              <option value={workspace.id} key={workspace.id}>
                {workspace.name}
                {workspace.active ? '' : ' (dormant)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Resume session (optional)
          <select
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
          >
            <option value="">New session</option>
            {sessions.map((session) => (
              <option value={session.id} key={session.id}>
                {sessionDisplayTitle(session)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Optional session name"
          />
        </label>
        <label>
          Initial prompt
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
          />
        </label>
        {error && <div className="error">{error}</div>}
        {error.includes('Both agents') && (
          <label className="check">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />{' '}
            I understand this shared-working-directory warning and want to start
            anyway.
          </label>
        )}
        <button type="submit" disabled={!workspaceId || mutation.isPending}>
          Start in a new tmux window
        </button>
      </form>
    </section>
  );
}
