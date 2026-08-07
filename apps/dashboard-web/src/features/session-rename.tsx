import {
  type DashboardLiveStore,
  dashboardHttpClient,
  renameSessionMutationOptions,
} from '@pi-dashboard/client';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

export function SessionRename({
  id,
  initialName,
  store,
  onRenamed,
}: {
  id: string;
  initialName?: string;
  store: DashboardLiveStore;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [error, setError] = useState<string>();
  const mutation = useMutation(
    renameSessionMutationOptions(dashboardHttpClient),
  );
  const busy = mutation.isPending;
  useEffect(() => setName(initialName ?? ''), [initialName]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value || busy) return;
    setError(undefined);
    const requestGeneration = store.getGeneration();
    try {
      const result = await mutation.mutateAsync({ id, name: value });
      store.applyMutationResult(result, requestGeneration);
      onRenamed(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <form className="session-rename" onSubmit={(event) => void submit(event)}>
      <label htmlFor="session-name">Name</label>
      <input
        id="session-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Session name"
        maxLength={512}
        disabled={busy}
      />
      <button type="submit" disabled={busy || !name.trim()}>
        {busy ? 'Saving…' : 'Rename'}
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
