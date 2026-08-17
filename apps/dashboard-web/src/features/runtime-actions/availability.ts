import type { RuntimeSnapshot } from '@pi-dashboard/protocol';

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
  ref: import('react').Ref<HTMLButtonElement>;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls'?: string;
  onKeyDown: (event: import('react').KeyboardEvent<HTMLButtonElement>) => void;
};
