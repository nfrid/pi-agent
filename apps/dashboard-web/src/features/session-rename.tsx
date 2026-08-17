import {
  type DashboardLiveStore,
  dashboardHttpClient,
  renameSessionMutationOptions,
} from '@pi-dashboard/client';
import { useMutation } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../shared/lib/error-message';

export function InlineSessionRename({
  id,
  title,
  store,
  onRenamed,
}: {
  id: string;
  title: string;
  store: DashboardLiveStore;
  onRenamed: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(title);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const cancelRef = useRef(false);
  const mutation = useMutation(
    renameSessionMutationOptions(dashboardHttpClient),
  );

  useEffect(() => {
    if (!editing) setName(title);
  }, [editing, title]);
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    cancelRef.current = false;
    setName(title);
    setError(undefined);
    setEditing(true);
  };
  const cancelEditing = () => {
    cancelRef.current = true;
    setName(title);
    setError(undefined);
    setEditing(false);
  };
  const save = async () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    if (savingRef.current) return;
    const value = name.trim();
    if (!value || value === title) {
      setName(title);
      setError(undefined);
      setEditing(false);
      return;
    }
    savingRef.current = true;
    setError(undefined);
    const requestGeneration = store.getGeneration();
    try {
      const result = await mutation.mutateAsync({ id, name: value });
      store.applyMutationResult(result, requestGeneration);
      onRenamed(value);
      setEditing(false);
    } catch (cause) {
      setError(errorMessage(cause));
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      savingRef.current = false;
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEditing();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  };

  if (!editing) {
    return (
      <h1 title={`${title} — double-click to rename`}>
        <button
          type="button"
          className="session-title-button"
          aria-label={`Rename session: ${title}`}
          onDoubleClick={startEditing}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'F2') startEditing();
          }}
        >
          {title}
        </button>
      </h1>
    );
  }

  return (
    <h1 className="session-title-editing">
      <input
        ref={inputRef}
        aria-label="Session name"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'session-title-error' : undefined}
        value={name}
        maxLength={512}
        disabled={mutation.isPending}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => void save()}
      />
      {error && (
        <span
          id="session-title-error"
          className="session-title-error"
          role="alert"
        >
          {error}
        </span>
      )}
    </h1>
  );
}
