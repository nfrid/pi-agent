import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export interface LifecycleGuardOptions {
  onSessionStart?: (ctx: ExtensionContext) => void;
  onSessionTree?: (ctx: ExtensionContext) => void;
  onSessionShutdown?: () => void;
  boundaryError?: string;
}

export interface LifecycleGuard {
  readonly generation: number;
  guard: (signal?: AbortSignal) => () => void;
  assertGeneration: (generation: number) => void;
  register: (pi: ExtensionAPI) => void;
}

const DEFAULT_BOUNDARY_ERROR =
  'Operation crossed a session lifecycle boundary.';

function defaultThrowIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

/** Tracks session lifecycle generation and rejects stale async work. */
export function createLifecycleGuard(
  options: LifecycleGuardOptions = {},
  throwIfAborted: (signal?: AbortSignal) => void = defaultThrowIfAborted,
): LifecycleGuard {
  let generation = 0;
  const boundaryError = options.boundaryError ?? DEFAULT_BOUNDARY_ERROR;

  const bump = (): void => {
    generation++;
  };

  return {
    get generation() {
      return generation;
    },
    assertGeneration(scheduled: number): void {
      if (scheduled !== generation) throw new Error(boundaryError);
    },
    guard(signal?: AbortSignal) {
      const scheduled = generation;
      return () => {
        throwIfAborted(signal);
        if (scheduled !== generation) throw new Error(boundaryError);
      };
    },
    register(pi: ExtensionAPI): void {
      pi.on('session_start', (_event, ctx) => {
        bump();
        options.onSessionStart?.(ctx);
      });
      pi.on('session_tree', (_event, ctx) => {
        bump();
        options.onSessionTree?.(ctx);
      });
      pi.on('session_shutdown', () => {
        bump();
        options.onSessionShutdown?.();
      });
    },
  };
}
