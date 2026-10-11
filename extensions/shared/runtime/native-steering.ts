export type NativeSteeringResult =
  | { status: 'accepted'; steerId: string }
  | { status: 'failed'; message: string }
  | { status: 'unknown'; message: string };

export interface NativeSteeringController {
  isAvailable(): boolean;
  /** Accepted input whose server successor is not yet consumed by Pi. */
  hasPendingContinuation?(): boolean;
  steer(
    input: string,
    onAccepted: () => void | Promise<void>,
  ): Promise<NativeSteeringResult>;
  close(reason?: string): void;
}

type Registry = {
  controllers: Map<string, NativeSteeringController>;
  activeSessions: Set<string>;
};

const registryKey = Symbol.for('pi.native-steering.registry');
type RegistryGlobal = typeof globalThis & { [registryKey]?: Registry };

function registry(): Registry {
  const root = globalThis as RegistryGlobal;
  let state = root[registryKey];
  if (!state) {
    state = {
      controllers: new Map(),
      activeSessions: new Set(),
    };
    root[registryKey] = state;
  }
  return state;
}

export function setNativeSteeringAgentActive(
  sessionId: string,
  active: boolean,
): void {
  const state = registry();
  if (active) state.activeSessions.add(sessionId);
  else state.activeSessions.delete(sessionId);
}

export function isNativeSteeringAgentActive(sessionId: string): boolean {
  return registry().activeSessions.has(sessionId);
}

export function registerNativeSteeringController(
  sessionId: string,
  controller: NativeSteeringController,
): void {
  const controllers = registry().controllers;
  const existing = controllers.get(sessionId);
  if (existing && existing !== controller) existing.close('replaced');
  controllers.set(sessionId, controller);
}

export function getNativeSteeringController(
  sessionId: string,
): NativeSteeringController | undefined {
  return registry().controllers.get(sessionId);
}

export function clearNativeSteeringController(
  sessionId: string,
  expected?: NativeSteeringController,
  reason = 'session ended',
): void {
  const state = registry();
  const controller = state.controllers.get(sessionId);
  if (!controller || (expected && controller !== expected)) return;
  state.controllers.delete(sessionId);
  controller.close(reason);
}

/** Close stale sockets when this extension runtime reloads. */
export function clearAllNativeSteeringControllers(
  reason = 'extension reloaded',
): void {
  const state = registry();
  const controllers = [...state.controllers.values()];
  state.controllers.clear();
  state.activeSessions.clear();
  for (const controller of controllers) controller.close(reason);
}
