import {
  dashboardHttpClient,
  restartRuntimeMutationOptions,
  stopRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
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

export type RuntimeLifecycleThreadProps = {
  ref: Ref<HTMLButtonElement>;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls'?: string;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

type RuntimeLifecycleActionsProps = {
  runtime: RuntimeSnapshot;
  title: string;
  rowClassName: string;
  children: (threadProps?: RuntimeLifecycleThreadProps) => ReactNode;
};

type ActiveTouch = {
  pointerId: number;
  clientX: number;
  clientY: number;
};

const LONG_PRESS_DELAY = 500;
const LONG_PRESS_MOVE_TOLERANCE = 8;

export function RuntimeLifecycleActions({
  runtime,
  title,
  rowClassName,
  children,
}: RuntimeLifecycleActionsProps) {
  const navigate = useNavigate();
  const rowRef = useRef<HTMLDivElement>(null);
  const threadButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<number | undefined>(undefined);
  const activeTouchRef = useRef<ActiveTouch | undefined>(undefined);
  const longPressTriggeredRef = useRef(false);
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
  const menuId = `agent-thread-actions-menu-${useId()}`;

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== undefined) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
    activeTouchRef.current = undefined;
    longPressTriggeredRef.current = false;
  }, []);

  const openMenu = useCallback(() => {
    setError(undefined);
    setOpen(true);
  }, []);

  const closeMenu = useCallback(
    (restoreFocus: boolean, preserveLongPressClick = false) => {
      if (!preserveLongPressClick || !longPressTriggeredRef.current) {
        cancelLongPress();
      } else {
        if (longPressTimerRef.current !== undefined) {
          window.clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = undefined;
        }
        activeTouchRef.current = undefined;
      }
      setOpen(false);
      if (restoreFocus) threadButtonRef.current?.focus();
    },
    [cancelLongPress],
  );

  useEffect(() => {
    return () => cancelLongPress();
  }, [cancelLongPress]);

  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        closeMenu(
          true,
          threadButtonRef.current?.contains(event.target) ?? false,
        );
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu(true);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeMenu, open]);

  const handleContextMenu = useCallback(
    (event: globalThis.MouseEvent) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      event.preventDefault();
      openMenu();
    },
    [openMenu],
  );
  const handlePointerDown = useCallback(
    (event: globalThis.PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      cancelLongPress();
      const { pointerId, clientX, clientY } = event;
      activeTouchRef.current = { pointerId, clientX, clientY };
      const row = event.currentTarget as HTMLDivElement;
      try {
        row.setPointerCapture?.(pointerId);
      } catch {
        // Synthetic pointer events and cancelled touches may not be capturable.
      }
      longPressTimerRef.current = window.setTimeout(() => {
        if (activeTouchRef.current?.pointerId !== pointerId) return;
        longPressTimerRef.current = undefined;
        longPressTriggeredRef.current = true;
        openMenu();
      }, LONG_PRESS_DELAY);
    },
    [cancelLongPress, openMenu],
  );
  const handlePointerMove = useCallback(
    (event: globalThis.PointerEvent) => {
      const activeTouch = activeTouchRef.current;
      if (!activeTouch || activeTouch.pointerId !== event.pointerId) return;
      if (
        Math.hypot(
          event.clientX - activeTouch.clientX,
          event.clientY - activeTouch.clientY,
        ) > LONG_PRESS_MOVE_TOLERANCE
      ) {
        cancelLongPress();
      }
    },
    [cancelLongPress],
  );
  const handlePointerUp = useCallback((event: globalThis.PointerEvent) => {
    const activeTouch = activeTouchRef.current;
    if (!activeTouch || activeTouch.pointerId !== event.pointerId) return;
    const triggered = longPressTriggeredRef.current;
    if (longPressTimerRef.current !== undefined) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
    activeTouchRef.current = undefined;
    if (!triggered) longPressTriggeredRef.current = false;
    const row = event.currentTarget as HTMLDivElement;
    if (row.hasPointerCapture(event.pointerId)) {
      row.releasePointerCapture(event.pointerId);
    }
  }, []);
  const handlePointerCancel = useCallback(
    (event: globalThis.PointerEvent) => {
      if (activeTouchRef.current?.pointerId !== event.pointerId) return;
      cancelLongPress();
    },
    [cancelLongPress],
  );
  const handleClickCapture = useCallback((event: globalThis.MouseEvent) => {
    if (!longPressTriggeredRef.current) return;
    const isThreadClick =
      event.target instanceof Node &&
      (threadButtonRef.current?.contains(event.target) ?? false);
    longPressTriggeredRef.current = false;
    if (!isThreadClick) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const handleThreadKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
  ): void => {
    const invokesMenu =
      event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
    if (invokesMenu) {
      event.preventDefault();
      event.stopPropagation();
      openMenu();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  };

  useEffect(() => {
    if (!hasActions) return;
    const row = rowRef.current;
    if (!row) return;
    row.addEventListener('contextmenu', handleContextMenu);
    row.addEventListener('pointerdown', handlePointerDown);
    row.addEventListener('pointermove', handlePointerMove);
    row.addEventListener('pointerup', handlePointerUp);
    row.addEventListener('pointercancel', handlePointerCancel);
    row.addEventListener('click', handleClickCapture, true);
    return () => {
      row.removeEventListener('contextmenu', handleContextMenu);
      row.removeEventListener('pointerdown', handlePointerDown);
      row.removeEventListener('pointermove', handlePointerMove);
      row.removeEventListener('pointerup', handlePointerUp);
      row.removeEventListener('pointercancel', handlePointerCancel);
      row.removeEventListener('click', handleClickCapture, true);
    };
  }, [
    handleClickCapture,
    handleContextMenu,
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    hasActions,
  ]);

  if (!hasActions) {
    return (
      <div ref={rowRef} className={rowClassName}>
        {children()}
      </div>
    );
  }

  const runStop = async (force: boolean) => {
    setError(undefined);
    try {
      await stop.mutateAsync({ runtimeId: runtime.runtimeId, force });
      if (!force) setGracefulStopFailed(false);
      closeMenu(true);
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
      closeMenu(true);
      await navigate({ to: `/runtimes/${nextId}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div ref={rowRef} className={rowClassName}>
      {children({
        ref: threadButtonRef,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onKeyDown: handleThreadKeyDown,
      })}
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className={`agent-thread-actions-menu ${navStyles.lifecycleActionsMenu}`}
          role="menu"
          aria-label={`Actions for ${title}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeMenu(true);
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
