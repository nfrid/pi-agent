import {
  dashboardHttpClient,
  restartRuntimeMutationOptions,
  stopRuntimeMutationOptions,
} from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useRef, useState } from 'react';
import { errorMessage } from '../../shared/lib/error-message';
import navStyles from '../agent-thread-nav.module.css';
import {
  type RuntimeLifecycleThreadProps,
  runtimeLifecycleActionAvailability,
} from './availability';
import { useRuntimeLifecycleMenu } from './lifecycle-menu';

type AgentThreadActionMenuProps = {
  title: string;
  rowClassName: string;
  menuItems: (actions: { closeMenu: () => void }) => ReactNode;
  children: (threadProps?: RuntimeLifecycleThreadProps) => ReactNode;
};

/** Shared context-menu wrapper for every sidebar thread, online or dormant. */
export function AgentThreadActionMenu({
  title,
  rowClassName,
  menuItems,
  children,
}: AgentThreadActionMenuProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const threadButtonRef = useRef<HTMLButtonElement>(null);
  const { closeMenu, threadProps, renderMenu } = useRuntimeLifecycleMenu({
    enabled: true,
    title,
    rowRef,
    threadButtonRef,
  });

  return (
    <div ref={rowRef} className={rowClassName}>
      {children(threadProps)}
      {renderMenu(menuItems({ closeMenu: () => closeMenu(true) }))}
    </div>
  );
}

type RuntimeLifecycleActionsProps = {
  runtime: RuntimeSnapshot;
  title: string;
  rowClassName: string;
  menuItems?: (actions: { closeMenu: () => void }) => ReactNode;
  children: (threadProps?: RuntimeLifecycleThreadProps) => ReactNode;
};

export function RuntimeLifecycleActions({
  runtime,
  title,
  rowClassName,
  menuItems,
  children,
}: RuntimeLifecycleActionsProps) {
  const navigate = useNavigate();
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
  const runStop = async (force: boolean, closeMenu: () => void) => {
    setError(undefined);
    try {
      await stop.mutateAsync({ runtimeId: runtime.runtimeId, force });
      if (!force) setGracefulStopFailed(false);
      closeMenu();
    } catch (cause) {
      if (!force) setGracefulStopFailed(true);
      setError(errorMessage(cause));
    }
  };
  const runRestart = async (closeMenu: () => void) => {
    setError(undefined);
    setRestarting(true);
    try {
      const result = await restart.mutateAsync({
        runtimeId: runtime.runtimeId,
      });
      const nextId = result.result.runtimeId;
      if (typeof nextId !== 'string')
        throw new Error('Restart did not return a runtime ID.');
      closeMenu();
      await navigate({ to: `/runtimes/${nextId}` });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <AgentThreadActionMenu
      title={title}
      rowClassName={rowClassName}
      menuItems={({ closeMenu }) => (
        <>
          {menuItems?.({ closeMenu })}
          {availability.canStop && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void runStop(false, closeMenu);
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
                void runStop(true, closeMenu);
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
                void runRestart(closeMenu);
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
        </>
      )}
    >
      {children}
    </AgentThreadActionMenu>
  );
}

export {
  type RuntimeLifecycleActionAvailability,
  type RuntimeLifecycleThreadProps,
  runtimeLifecycleActionAvailability,
} from './availability';
