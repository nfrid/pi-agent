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
import {
  CONTINUE_ACTION_ID,
  PAUSE_ACTION_ID,
} from '../../../../extensions/pause/contribution';
import { runtimePauseStatus } from './extension-surfaces';

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
  const supportsAction = (actionId: string) =>
    Boolean(
      runtime.capabilities?.manifests.some((manifest) =>
        manifest.actions.some((candidate) => candidate.id === actionId),
      ),
    );
  const compactSupported = supportsAction('session.compact');
  const pauseSupported = supportsAction(PAUSE_ACTION_ID);
  const continueSupported = supportsAction(CONTINUE_ACTION_ID);
  const pauseStatus = runtimePauseStatus(runtime);
  const paused = Boolean(pauseStatus);
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
      {pauseStatus && (
        <span className="runtime-pause-label" role="status">
          {pauseStatus.label}
        </span>
      )}
      {pauseSupported && continueSupported && (
        <button
          type="button"
          disabled={onlineOnly}
          onClick={() =>
            void run(() =>
              action.mutateAsync({
                runtimeId: runtime.runtimeId,
                actionId: paused ? CONTINUE_ACTION_ID : PAUSE_ACTION_ID,
                input: {},
              }),
            )
          }
        >
          {paused ? 'Continue' : 'Pause'}
        </button>
      )}
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
