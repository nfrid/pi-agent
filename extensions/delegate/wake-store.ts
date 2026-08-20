import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {
  WakeCoordinator,
  WakeCoordinatorSnapshot,
  WakeSnapshot,
} from './wake-coordinator';
import { WAKE_MAX_SUBSCRIPTIONS } from './wake-coordinator';

/** Custom entry type for append-only wake metadata. */
export const WAKE_ENTRY_TYPE = 'delegate-wake:v1';
/** Keep each replacement delta bounded independently of the wake cap. */
export const MAX_WAKE_DELTA_WAKES = 32;

export interface WakeStoreSnapshotEntry {
  readonly version: 1;
  readonly kind: 'snapshot';
  readonly state: WakeCoordinatorSnapshot;
}

export interface WakeStoreDeltaEntry {
  readonly version: 1;
  readonly kind: 'delta';
  /** Complete replacement records for only the wakes changed since the last append. */
  readonly state: WakeCoordinatorSnapshot;
}

export type WakeStoreEntry = WakeStoreSnapshotEntry | WakeStoreDeltaEntry;

type AppendOnly = Pick<ExtensionAPI, 'appendEntry'>;
type SessionBranch = Pick<ExtensionContext, 'sessionManager'>;
type PersistedWakes = Map<string, WakeSnapshot>;

const persistedWakes = new WeakMap<WakeCoordinator, PersistedWakes>();
const WAKE_STATES = new Set([
  'pending',
  'ready',
  'queued',
  'entered',
  'cancelled',
  'blocked',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validOwnerSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function validOwnerEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validWakeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
  );
}

function sanitizeCondition(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  if (typeof value.node === 'string') return { node: value.node };
  for (const kind of ['all', 'any'] as const) {
    const references = value[kind];
    if (
      Array.isArray(references) &&
      references.length <= 32 &&
      references.every((reference) => typeof reference === 'string')
    )
      return { [kind]: [...references] };
  }
  return undefined;
}

function sanitizePayload(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8)
    return undefined;
  const sanitized = value.map((selector) => {
    if (selector === 'handoff' || selector === 'metadata') return selector;
    if (!isRecord(selector)) return undefined;
    const keys = Object.keys(selector);
    const node = selector.node;
    if (node !== undefined && typeof node !== 'string') return undefined;
    if (selector.kind === 'handoff' || selector.kind === 'metadata') {
      const allowed = node === undefined ? ['kind'] : ['kind', 'node'];
      if (keys.some((key) => !allowed.includes(key))) return undefined;
      return {
        kind: selector.kind,
        ...(node === undefined ? {} : { node }),
      };
    }
    return undefined;
  });
  return sanitized.every((selector) => selector !== undefined)
    ? sanitized
    : undefined;
}

/**
 * Keep only the coordinator's durable metadata fields. In particular, an
 * untrusted entry cannot make a raw handoff/result field part of a folded
 * state or return value.
 */
function sanitizeWakeSnapshot(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !validWakeId(value.id)) return undefined;
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.state !== 'string' ||
    !WAKE_STATES.has(value.state) ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !Array.isArray(value.references) ||
    value.references.length > 32 ||
    value.references.some((reference) => typeof reference !== 'string')
  )
    return undefined;
  const condition = sanitizeCondition(value.condition);
  const payload = sanitizePayload(value.payload);
  if (!condition || !payload) return undefined;
  const result: Record<string, unknown> = {
    id: value.id,
    ownerSessionId: value.ownerSessionId,
    ownerEpoch: value.ownerEpoch,
    deliveryKey: value.deliveryKey,
    condition,
    references: [...value.references],
    payload,
    nonObstructive: value.nonObstructive === true,
    state: value.state,
    createdAt: value.createdAt,
    revision: value.revision,
    dispatchGeneration: value.dispatchGeneration,
    dispatchAttempts: value.dispatchAttempts,
  };
  for (const key of [
    'readyAt',
    'readyReferences',
    'queuedAt',
    'enteredAt',
    'cancelledAt',
    'blockedAt',
    'enteredAcknowledgement',
    'warnings',
  ] as const) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function validWakeState(
  value: unknown,
  maximumWakes: number,
): value is WakeCoordinatorSnapshot {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !validOwnerSessionId(value.ownerSessionId) ||
    !validOwnerEpoch(value.ownerEpoch) ||
    !Array.isArray(value.wakes) ||
    value.wakes.length > maximumWakes
  )
    return false;
  const ids = new Set<string>();
  for (const wake of value.wakes) {
    const sanitized = sanitizeWakeSnapshot(wake);
    if (
      !sanitized ||
      typeof sanitized.id !== 'string' ||
      ids.has(sanitized.id) ||
      sanitized.ownerSessionId !== value.ownerSessionId ||
      sanitized.ownerEpoch !== value.ownerEpoch ||
      sanitized.deliveryKey !==
        `${value.ownerSessionId}:${value.ownerEpoch}:${sanitized.id}`
    )
      return false;
    ids.add(sanitized.id);
  }
  return true;
}

function canonicalState(
  value: Record<string, unknown>,
): WakeCoordinatorSnapshot {
  return {
    version: 1,
    ownerSessionId: value.ownerSessionId as string,
    ownerEpoch: value.ownerEpoch as number,
    wakes: Object.freeze(value.wakes as readonly WakeSnapshot[]),
  };
}

function parseWakeStoreEntry(value: unknown): WakeStoreEntry | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const kind = value.kind;
  const maximum =
    kind === 'snapshot' ? WAKE_MAX_SUBSCRIPTIONS : MAX_WAKE_DELTA_WAKES;
  if (
    (kind !== 'snapshot' && kind !== 'delta') ||
    !validWakeState(value.state, maximum)
  )
    return undefined;
  const state = value.state as unknown as Record<string, unknown>;
  const sourceWakes = state.wakes as unknown[];
  const wakes = sourceWakes
    .map(sanitizeWakeSnapshot)
    .filter((wake): wake is Record<string, unknown> => wake !== undefined);
  if (wakes.length !== sourceWakes.length) return undefined;
  return {
    version: 1,
    kind,
    state: canonicalState({ ...state, wakes }),
  } as WakeStoreEntry;
}

function metadataMap(state: WakeCoordinatorSnapshot): PersistedWakes {
  return new Map(state.wakes.map((wake) => [wake.id, wake]));
}

function sameWake(left: WakeSnapshot, right: WakeSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isTerminal(state: string): boolean {
  return state === 'entered' || state === 'cancelled' || state === 'blocked';
}

function progress(state: string): number {
  if (state === 'pending') return 0;
  if (state === 'ready') return 1;
  if (state === 'queued') return 2;
  return 3;
}

/** Match the coordinator's stale-state protection while folding journal records. */
function keepPriorWake(live: WakeSnapshot, incoming: WakeSnapshot): boolean {
  if (live.revision >= incoming.revision) return true;
  const liveProgress = progress(live.state);
  const incomingProgress = progress(incoming.state);
  if (liveProgress > incomingProgress) return true;
  if (liveProgress === incomingProgress && live.state !== incoming.state)
    return true;
  if (isTerminal(live.state) && live.state !== incoming.state) return true;
  if (live.state === 'queued' && incoming.state !== 'queued') return true;
  return false;
}

interface FoldedWakeHistory {
  readonly states: readonly WakeCoordinatorSnapshot[];
  readonly latest?: WakeCoordinatorSnapshot;
}

function wakeHistory(ctx: SessionBranch): FoldedWakeHistory | undefined {
  const ledger = new Map<string, WakeSnapshot>();
  const states: WakeCoordinatorSnapshot[] = [];
  let ownerSessionId: string | undefined;
  let ownerEpoch: number | undefined;
  let found = false;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      !isRecord(entry) ||
      entry.type !== 'custom' ||
      entry.customType !== WAKE_ENTRY_TYPE
    )
      continue;
    found = true;
    const parsed = parseWakeStoreEntry(entry.data);
    // A malformed journal entry invalidates the whole fold. Never expose a
    // valid prefix as if it were the current wake state.
    if (!parsed) return undefined;
    const state = parsed.state;
    if (
      ownerSessionId !== state.ownerSessionId ||
      ownerEpoch !== state.ownerEpoch
    ) {
      ledger.clear();
      // Wake ownership changes at a branch boundary. Older-owner entries are
      // valid history but cannot be applied to the current coordinator.
      states.length = 0;
      ownerSessionId = state.ownerSessionId;
      ownerEpoch = state.ownerEpoch;
    }

    if (parsed.kind === 'snapshot') {
      const prior = new Map(ledger);
      ledger.clear();
      for (const wake of state.wakes) {
        const old = prior.get(wake.id);
        ledger.set(wake.id, old && keepPriorWake(old, wake) ? old : wake);
      }
    } else {
      for (const wake of state.wakes) {
        const old = ledger.get(wake.id);
        if (!old || !keepPriorWake(old, wake)) ledger.set(wake.id, wake);
      }
    }
    if (ledger.size > WAKE_MAX_SUBSCRIPTIONS) return undefined;
    const folded: WakeCoordinatorSnapshot = {
      version: 1,
      ownerSessionId: state.ownerSessionId,
      ownerEpoch: state.ownerEpoch,
      wakes: Object.freeze([...ledger.values()]),
    };
    // Expand every operation to the same folded representation so checkpoints
    // and replacement deltas have identical transactional restore semantics.
    states.push(folded);
  }
  if (!found) return { states: [] };
  return {
    states,
    latest:
      ownerSessionId === undefined || ownerEpoch === undefined
        ? undefined
        : {
            version: 1,
            ownerSessionId,
            ownerEpoch,
            wakes: Object.freeze([...ledger.values()]),
          },
  };
}

/** Append one complete metadata checkpoint (the compatibility v1 format). */
export function persistWakeState(
  coordinator: WakeCoordinator,
  pi: AppendOnly,
): void {
  const state = coordinator.snapshot();
  pi.appendEntry(WAKE_ENTRY_TYPE, {
    version: 1,
    kind: 'snapshot',
    state,
  } satisfies WakeStoreSnapshotEntry);
  // Mark only after appendEntry succeeds. A failed append remains dirty.
  persistedWakes.set(coordinator, metadataMap(state));
}

/** Append only changed wake replacement records in bounded batches. */
export function persistWakeDelta(
  coordinator: WakeCoordinator,
  pi: AppendOnly,
): void {
  const state = coordinator.snapshot();
  const previous = persistedWakes.get(coordinator) ?? new Map();
  const changed = state.wakes.filter((wake) => {
    const prior = previous.get(wake.id);
    return prior === undefined || !sameWake(prior, wake);
  });
  if (changed.length === 0) return;

  const next = new Map(previous);
  for (
    let offset = 0;
    offset < changed.length;
    offset += MAX_WAKE_DELTA_WAKES
  ) {
    const wakes = changed.slice(offset, offset + MAX_WAKE_DELTA_WAKES);
    const delta: WakeStoreDeltaEntry = {
      version: 1,
      kind: 'delta',
      state: {
        version: 1,
        ownerSessionId: state.ownerSessionId,
        ownerEpoch: state.ownerEpoch,
        wakes: Object.freeze(wakes),
      },
    };
    pi.appendEntry(WAKE_ENTRY_TYPE, delta);
    // If a later batch fails, successful batches remain acknowledged and the
    // remainder is still dirty. If this append itself fails, this map is left
    // at the prior successful baseline.
    for (const wake of wakes) next.set(wake.id, wake);
    persistedWakes.set(coordinator, new Map(next));
  }
}

/** Seed a restored coordinator with the exact durable fold baseline. */
export function seedWakePersistence(
  coordinator: WakeCoordinator,
  state: WakeCoordinatorSnapshot | undefined,
): void {
  if (state) persistedWakes.set(coordinator, metadataMap(state));
}

/** Return the latest folded state on the current session branch. */
export function latestWakeState(
  ctx: SessionBranch,
): WakeCoordinatorSnapshot | undefined {
  return wakeHistory(ctx)?.latest;
}

/**
 * Restore validated append-only wake history on the current session branch.
 * Invalid history fails closed; the coordinator consolidates each wake by
 * revision/state before changing live records.
 */
export function restoreWakeState(
  coordinator: WakeCoordinator,
  ctx: SessionBranch,
): void {
  const history = wakeHistory(ctx);
  if (!history?.states.length) return;
  if (coordinator.restoreHistory(history.states))
    // Seed from the folded pre-restore state. Orphan blocking performed by the
    // coordinator is intentionally left dirty for the next attachment.
    seedWakePersistence(coordinator, history.latest);
}

/** Attach delta persistence and retry any dirty state on reactivation. */
export function attachWakeStore(
  coordinator: WakeCoordinator,
  pi: AppendOnly,
): () => void {
  persistWakeDelta(coordinator, pi);
  return coordinator.subscribeChanges(() => persistWakeDelta(coordinator, pi));
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
