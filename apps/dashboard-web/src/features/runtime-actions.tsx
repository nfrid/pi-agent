import {
  dashboardHttpClient,
  restartRuntimeMutationOptions,
  stopRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import navStyles from './agent-thread-nav.module.css';

export type RuntimeLifecycleActionAvailability = {
  canStop: boolean;
  canRestart: boolean;
  canForceStop: boolean;
};

/** Keep force stop hidden until graceful shutdown fails or remains pending. */
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
    return () => window.removeEventListener('pointerdown', onPointerDown);
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
