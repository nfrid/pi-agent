import {
  actionMutationOptions,
  commandMutationOptions,
  dashboardHttpClient,
  restartRuntimeMutationOptions,
  stopRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

export function RuntimeActions({ runtime }: { runtime: RuntimeSnapshot }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [restarting, setRestarting] = useState(false);
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const action = useMutation(actionMutationOptions(dashboardHttpClient));
  const stop = useMutation(stopRuntimeMutationOptions(dashboardHttpClient));
  const restart = useMutation(
    restartRuntimeMutationOptions(dashboardHttpClient),
  );
  const busy =
    restarting ||
    command.isPending ||
    action.isPending ||
    stop.isPending ||
    restart.isPending;
  const compactSupported = Boolean(
    runtime.capabilities?.manifests.some((manifest) =>
      manifest.actions.some((candidate) => candidate.id === 'session.compact'),
    ),
  );
  const run = async (operation: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const onlineOnly = busy || runtime.online === false;
  return (
    <div className="actions">
      <button
        type="button"
        disabled={onlineOnly}
        onClick={() =>
          void run(() =>
            command.mutateAsync({
              runtimeId: runtime.runtimeId,
              command: { type: 'abort' },
            }),
          )
        }
      >
        Abort
      </button>
      {compactSupported && (
        <button
          type="button"
          disabled={onlineOnly}
          onClick={() =>
            void run(() =>
              action.mutateAsync({
                runtimeId: runtime.runtimeId,
                actionId: 'session.compact',
                input: {},
              }),
            )
          }
        >
          Compact
        </button>
      )}
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() =>
          void run(() =>
            stop.mutateAsync({ runtimeId: runtime.runtimeId, force: false }),
          )
        }
      >
        Stop
      </button>
      {runtime.ownership === 'managed' && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setRestarting(true);
                try {
                  const result = (await restart.mutateAsync(
                    runtime.runtimeId,
                  )) as { result?: { runtimeId?: unknown } };
                  const nextId = result.result?.runtimeId;
                  if (typeof nextId !== 'string')
                    throw new Error('Restart did not return a runtime ID.');
                  await navigate({ to: `/runtimes/${nextId}` });
                } finally {
                  setRestarting(false);
                }
              })
            }
          >
            {restarting ? 'Restarting…' : 'Restart'}
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() =>
              void run(() =>
                stop.mutateAsync({
                  runtimeId: runtime.runtimeId,
                  force: true,
                }),
              )
            }
          >
            Force stop
          </button>
        </>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
