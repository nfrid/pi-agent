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
import { useEffect, useRef, useState } from 'react';
import {
  CONTINUE_ACTION_ID,
  PAUSE_ACTION_ID,
} from '../../../../extensions/pause/contribution';
import navStyles from './agent-thread-nav.module.css';
import { runtimePauseStatus } from './extension-surfaces';

export type RuntimeLifecycleActionAvailability = {
  canStop: boolean;
  canRestart: boolean;
  canForceStop: boolean;
};

/**
 * Keep the destructive escalation out of the initial lifecycle affordance.
 * A force stop is only available after a graceful request failed or the
 * runtime is explicitly still stopping.
 */
export function runtimeLifecycleActionAvailability(
  runtime: RuntimeSnapshot,
  gracefulStopFailed = false,
): RuntimeLifecycleActionAvailability {
  return {
    canStop:
      !gracefulStopFailed &&
      runtime.online !== false &&
      runtime.liveState !== 'stopping',
    canRestart: runtime.ownership === 'managed',
    canForceStop: gracefulStopFailed || runtime.liveState === 'stopping',
  };
}

export function RuntimeLifecycleActions({
  runtime,
  title,
}: {
  runtime: RuntimeSnapshot;
  title: string;
}) {
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [gracefulStopFailed, setGracefulStopFailed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const stop = useMutation(stopRuntimeMutationOptions(dashboardHttpClient));
  const restart = useMutation(
    restartRuntimeMutationOptions(dashboardHttpClient),
  );
  const availability = runtimeLifecycleActionAvailability(
    runtime,
    gracefulStopFailed,
  );
  const busy = stop.isPending || restart.isPending || restarting;
  const hasActions =
    availability.canStop ||
    availability.canRestart ||
    availability.canForceStop;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  if (!hasActions) return null;

  const runStop = async (force: boolean) => {
    setError(undefined);
    try {
      await stop.mutateAsync({ runtimeId: runtime.runtimeId, force });
      if (!force) setGracefulStopFailed(false);
      setOpen(false);
    } catch (cause) {
      if (!force) setGracefulStopFailed(true);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const runRestart = async () => {
    setError(undefined);
    setRestarting(true);
    try {
      const result = (await restart.mutateAsync(runtime.runtimeId)) as {
        result?: { runtimeId?: unknown };
      };
      const nextId = result.result?.runtimeId;
      if (typeof nextId !== 'string')
        throw new Error('Restart did not return a runtime ID.');
      setOpen(false);
      await navigate({ to: `/runtimes/${nextId}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div
      ref={menuRef}
      className={`agent-thread-actions ${navStyles.lifecycleActions}`}
    >
      <button
        type="button"
        className={`agent-thread-actions-trigger ${navStyles.lifecycleActionsTrigger}`}
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setError(undefined);
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          className={`agent-thread-actions-menu ${navStyles.lifecycleActionsMenu}`}
          role="menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {availability.canStop && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void runStop(false);
              }}
            >
              Stop
            </button>
          )}
          {availability.canForceStop && (
            <button
              type="button"
              role="menuitem"
              className={`danger ${navStyles.lifecycleActionDanger}`}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void runStop(true);
              }}
            >
              Force stop
            </button>
          )}
          {availability.canRestart && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void runRestart();
              }}
            >
              {restarting ? 'Restarting…' : 'Restart'}
            </button>
          )}
          {error && (
            <span className="error" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

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
