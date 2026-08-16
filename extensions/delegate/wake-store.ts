import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {
  WakeCoordinator,
  WakeCoordinatorSnapshot,
} from './wake-coordinator';

/** Custom entry type for append-only wake metadata. */
export const WAKE_ENTRY_TYPE = 'delegate-wake:v1';

export interface WakeStoreEntry {
  readonly version: 1;
  readonly kind: 'snapshot';
  readonly state: WakeCoordinatorSnapshot;
}

type AppendOnly = Pick<ExtensionAPI, 'appendEntry'>;
type SessionBranch = Pick<ExtensionContext, 'sessionManager'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWakeStoreEntry(value: unknown): value is WakeStoreEntry {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.kind === 'snapshot' &&
    isRecord(value.state) &&
    value.state.version === 1 &&
    Array.isArray(value.state.wakes)
  );
}

/** Append one metadata-only snapshot. Raw reports/results are never accepted. */
export function persistWakeState(
  coordinator: WakeCoordinator,
  pi: AppendOnly,
): void {
  const state = coordinator.snapshot();
  pi.appendEntry(WAKE_ENTRY_TYPE, {
    version: 1,
    kind: 'snapshot',
    state,
  } satisfies WakeStoreEntry);
}

/**
 * Restore the validated append-only wake history on the current session
 * branch. Invalid history is fail-closed; the coordinator consolidates each
 * wake by revision/state before changing live records.
 */
export function restoreWakeState(
  coordinator: WakeCoordinator,
  ctx: SessionBranch,
): void {
  const history: WakeStoreEntry[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      !isRecord(entry) ||
      entry.type !== 'custom' ||
      entry.customType !== WAKE_ENTRY_TYPE
    )
      continue;
    if (!isWakeStoreEntry(entry.data)) return;
    history.push(entry.data);
  }
  if (history.length > 0)
    coordinator.restoreHistory(history.map((entry) => entry.state));
}

/** Attach append-only persistence to wake state changes. */
export function attachWakeStore(
  coordinator: WakeCoordinator,
  pi: AppendOnly,
): () => void {
  return coordinator.subscribeChanges(() => persistWakeState(coordinator, pi));
}

/** Small adapter facade useful at extension/session boundaries. */
export class WakeStore {
  persist(coordinator: WakeCoordinator, pi: AppendOnly): void {
    persistWakeState(coordinator, pi);
  }

  restore(coordinator: WakeCoordinator, ctx: SessionBranch): void {
    restoreWakeState(coordinator, ctx);
  }

  attach(coordinator: WakeCoordinator, pi: AppendOnly): () => void {
    return attachWakeStore(coordinator, pi);
  }
}

export function createWakeStore(): WakeStore {
  return new WakeStore();
}
