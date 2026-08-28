import {
  activeWakeCount,
  type CanonicalWakePayloadSelector,
  isWakeTerminal,
  mergeWakeRestoreRecords,
  needsWakeReloadBlock,
  normalizeWakeCondition,
  normalizeWakePayload,
  parseWakeRestoreSnapshot,
  type WakeAcknowledgement,
  type WakeCondition,
  type WakePayload,
  type WakePayloadSource,
  type WakeRestoreRecord,
  type WakeState,
  type WakeSubscriptionOptions,
} from './wake-restore-policy';

export type {
  CanonicalWakePayloadSelector,
  WakeAcknowledgement,
  WakeCondition,
  WakePayload,
  WakePayloadKind,
  WakePayloadSelector,
  WakePayloadSource,
  WakeState,
  WakeSubscriptionOptions,
} from './wake-restore-policy';

import {
  type DelegateWorkflowAttemptSnapshot,
  type DelegateWorkflowCoordinator,
  WORKFLOW_RELOAD_ORPHAN_REASON,
} from './workflow-coordinator';
import type {
  BoundWorkflowSelector,
  ResolvedWorkflowInput,
  SymbolicWorkflowSelector,
} from './workflow-inputs';
import {
  type AttemptIdentity,
  isTerminalWorkflowAttemptState,
} from './workflow-model';

export const WAKE_COORDINATOR_VERSION = 1 as const;
/** Fixed, metadata-only reason for wakes whose workflow was not rehydrated. */
export const WAKE_RELOAD_ORPHAN_REASON =
  'Wake blocked: workflow state unavailable after reload.' as const;
export const WAKE_ID_MAX_LENGTH = 64;
export const WAKE_MAX_SUBSCRIPTIONS = 256;
export const WAKE_MAX_CONDITION_REFERENCES = 32;
export const WAKE_MAX_PAYLOAD_SELECTORS = 8;
export const WAKE_PAYLOAD_CAPS = {
  handoffBytes: 12 * 1024,
  metadataBytes: 8 * 1024,
  aggregateBytes: 24 * 1024,
} as const;

const WAKE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DEFAULT_OWNER_SESSION_ID = 'default';
const DEFAULT_OWNER_EPOCH = 0;
const MAX_OWNER_SESSION_ID_LENGTH = 256;

export interface WakeWarning {
  readonly wakeId: string;
  readonly message: string;
}

export interface WakeSnapshot {
  readonly id: string;
  readonly ownerSessionId: string;
  readonly ownerEpoch: number;
  readonly deliveryKey: string;
  readonly condition: WakeCondition;
  /** Exact attempt identities captured when the subscription was registered. */
  readonly references: readonly AttemptIdentity[];
  readonly payload: readonly CanonicalWakePayloadSelector[];
  readonly nonObstructive: boolean;
  readonly state: WakeState;
  readonly createdAt: number;
  readonly readyAt?: number;
  /** Exact sources selected at the readiness transition, for recovery. */
  readonly readyReferences?: readonly AttemptIdentity[];
  readonly queuedAt?: number;
  readonly enteredAt?: number;
  readonly cancelledAt?: number;
  readonly blockedAt?: number;
  readonly revision: number;
  readonly dispatchGeneration: number;
  readonly enteredAcknowledgement?: WakeAcknowledgement;
  readonly warnings?: readonly string[];
  readonly dispatchAttempts: number;
  readonly lastDispatchFailure?: string;
  readonly reason?: string;
}

export interface WakeCoordinatorSnapshot {
  readonly version: typeof WAKE_COORDINATOR_VERSION;
  readonly ownerSessionId: string;
  readonly ownerEpoch: number;
  readonly wakes: readonly WakeSnapshot[];
}

export interface WakeDispatch {
  readonly wake: WakeSnapshot;
  readonly acknowledgement: WakeAcknowledgement;
  readonly ownerSessionId: string;
  readonly ownerEpoch: number;
  readonly deliveryKey: string;
  readonly payload: WakePayload;
}

export type WakeDispatchHandler = (
  dispatch: WakeDispatch,
) => void | Promise<void>;
export type WakeListener = (wake: WakeSnapshot) => void;

export interface WakeCoordinatorOptions {
  readonly workflow: DelegateWorkflowCoordinator;
  readonly ownerSessionId?: string;
  readonly ownerEpoch?: number;
  /** Alias for ownerEpoch at delivery integration boundaries. */
  readonly deliveryEpoch?: number;
  readonly now?: () => number;
  readonly dispatch?: WakeDispatchHandler;
  readonly onChange?: () => void;
  readonly onWarning?: (warning: WakeWarning) => void;
}

type WakeRecord = WakeRestoreRecord;

class WakePayloadPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WakePayloadPendingError';
  }
}

function validateOwnerSessionId(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_OWNER_SESSION_ID_LENGTH ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error('Invalid wake owner session ID.');
}

function validateOwnerEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid wake owner epoch.');
}

function deliveryKey(
  ownerSessionId: string,
  ownerEpoch: number,
  id: string,
): string {
  return `${ownerSessionId}:${ownerEpoch}:${id}`;
}

function boundedReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const normalized = text.trim() || 'Wake dispatch failed.';
  return normalized.length > 256 ? `${normalized.slice(0, 255)}…` : normalized;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** @internal Exported for boundary-focused tests. */
export function cloneAndFreezeWakeJson(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Wake payload contains a cycle.');
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => cloneAndFreezeWakeJson(item, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(result, key, {
      value: cloneAndFreezeWakeJson(item, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  seen.delete(value);
  return Object.freeze(result);
}

function copyCondition(condition: WakeCondition): WakeCondition {
  if ('node' in condition) return Object.freeze({ node: condition.node });
  if ('all' in condition)
    return Object.freeze({ all: Object.freeze([...condition.all]) });
  return Object.freeze({ any: Object.freeze([...condition.any]) });
}

function copyAcknowledgement(
  acknowledgement: WakeAcknowledgement,
): WakeAcknowledgement {
  return Object.freeze({ ...acknowledgement });
}

function copyPayloadSelectors(
  selectors: readonly CanonicalWakePayloadSelector[],
): readonly CanonicalWakePayloadSelector[] {
  return Object.freeze(
    selectors.map((selector) => Object.freeze({ ...selector })),
  );
}

function copySnapshot(record: WakeRecord): WakeSnapshot {
  return Object.freeze({
    id: record.id,
    ownerSessionId: record.ownerSessionId,
    ownerEpoch: record.ownerEpoch,
    deliveryKey: deliveryKey(
      record.ownerSessionId,
      record.ownerEpoch,
      record.id,
    ),
    condition: copyCondition(record.condition),
    references: Object.freeze([...record.references]),
    payload: copyPayloadSelectors(record.payloadSelectors),
    nonObstructive: record.nonObstructive,
    state: record.state,
    createdAt: record.createdAt,
    readyAt: record.readyAt,
    readyReferences:
      record.readyReferences === undefined
        ? undefined
        : Object.freeze([...record.readyReferences]),
    queuedAt: record.queuedAt,
    enteredAt: record.enteredAt,
    cancelledAt: record.cancelledAt,
    blockedAt: record.blockedAt,
    revision: record.revision,
    dispatchGeneration: record.dispatchGeneration,
    enteredAcknowledgement:
      record.enteredAcknowledgement === undefined
        ? undefined
        : copyAcknowledgement(record.enteredAcknowledgement),
    warnings:
      record.warnings === undefined
        ? undefined
        : Object.freeze([...record.warnings]),
    dispatchAttempts: record.dispatchAttempts,
    lastDispatchFailure: record.lastDispatchFailure,
    reason: record.reason,
  });
}

function sameAcknowledgement(
  left: WakeAcknowledgement | undefined,
  right: WakeAcknowledgement,
): boolean {
  return (
    left?.deliveryKey === right.deliveryKey &&
    left.dispatchGeneration === right.dispatchGeneration &&
    left.dispatchAttempt === right.dispatchAttempt
  );
}

/**
 * Pure, one-shot wake state machine. It observes workflow terminal events but
 * owns neither jobs nor model-facing delivery. The dispatch callback is an
 * integration seam; entering is always an explicit acknowledgement.
 */
export class WakeCoordinator {
  readonly workflow: DelegateWorkflowCoordinator;
  readonly ownerSessionId: string;
  readonly ownerEpoch: number;
  private readonly now: () => number;
  private dispatchHandler?: WakeDispatchHandler;
  private readonly onChange?: () => void;
  private readonly onWarning?: (warning: WakeWarning) => void;
  private readonly records = new Map<string, WakeRecord>();
  private readonly listeners = new Set<WakeListener>();
  private disposed = false;
  private readonly unsubscribeWorkflow: () => void;

  constructor(options: WakeCoordinatorOptions) {
    this.workflow = options.workflow;
    this.ownerSessionId = options.ownerSessionId ?? DEFAULT_OWNER_SESSION_ID;
    const configuredEpoch = options.ownerEpoch ?? options.deliveryEpoch;
    this.ownerEpoch = configuredEpoch ?? DEFAULT_OWNER_EPOCH;
    validateOwnerSessionId(this.ownerSessionId);
    validateOwnerEpoch(this.ownerEpoch);
    if (
      options.ownerEpoch !== undefined &&
      options.deliveryEpoch !== undefined &&
      options.ownerEpoch !== options.deliveryEpoch
    )
      throw new Error('Wake owner and delivery epochs disagree.');
    this.now = options.now ?? Date.now;
    this.dispatchHandler = options.dispatch;
    this.onChange = options.onChange;
    this.onWarning = options.onWarning;
    this.unsubscribeWorkflow = this.workflow.subscribeTerminal(() =>
      this.reevaluatePending(),
    );
  }

  register(options: WakeSubscriptionOptions): WakeSnapshot {
    if (this.disposed) throw new Error('Wake coordinator is disposed.');
    this.validateId(options.id);
    if (this.records.has(options.id))
      throw new Error(`Wake ID "${options.id}" is already registered.`);
    if (activeWakeCount(this.records.values()) >= WAKE_MAX_SUBSCRIPTIONS)
      throw new Error('Too many wake subscriptions.');
    const normalized = normalizeWakeCondition(
      options.condition,
      WAKE_MAX_CONDITION_REFERENCES,
    );
    const references = normalized.references.map((reference) => {
      const attempt = this.workflow.require(reference);
      return attempt.identity;
    });
    if (new Set(references).size !== references.length) {
      const kind =
        'node' in normalized.condition
          ? 'node'
          : 'all' in normalized.condition
            ? 'all'
            : 'any';
      throw new Error(`Duplicate wake ${kind} references are not allowed.`);
    }
    const payloadSelectors = this.bindPayloadSelectors(
      normalizeWakePayload(options, WAKE_MAX_PAYLOAD_SELECTORS),
      references,
    );
    const boundCondition = this.bindCondition(normalized.condition, references);
    const warnings = this.overlapWarnings(
      boundCondition,
      references,
      payloadSelectors,
    );
    const timestamp = this.now();
    const record: WakeRecord = {
      id: options.id,
      ownerSessionId: this.ownerSessionId,
      ownerEpoch: this.ownerEpoch,
      condition: boundCondition,
      references: Object.freeze([...references]),
      payloadSelectors,
      nonObstructive: options.nonObstructive === true,
      createdAt: timestamp,
      state: 'pending',
      warnings: warnings.length > 0 ? Object.freeze(warnings) : undefined,
      revision: 0,
      dispatchAttempts: 0,
      dispatchGeneration: 0,
    };
    // Reserve before warning callbacks: a reentrant registration cannot reuse
    // this stable ID or replace the record being announced.
    this.records.set(record.id, record);
    for (const message of warnings) {
      try {
        this.onWarning?.({ wakeId: record.id, message });
      } catch {
        // Warning observers cannot prevent registration.
      }
    }
    this.emit(record);
    this.reevaluate(record);
    return copySnapshot(record);
  }

  subscribe(options: WakeSubscriptionOptions): WakeSnapshot {
    return this.register(options);
  }

  get(id: string): WakeSnapshot | undefined {
    const record = this.records.get(id);
    return record ? copySnapshot(record) : undefined;
  }

  require(id: string): WakeSnapshot {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown wake ID "${id}".`);
    return copySnapshot(record);
  }

  list(): WakeSnapshot[] {
    return [...this.records.values()]
      .filter((record) => !isWakeTerminal(record.state))
      .map(copySnapshot);
  }

  snapshot(): WakeCoordinatorSnapshot {
    return Object.freeze({
      version: WAKE_COORDINATOR_VERSION,
      ownerSessionId: this.ownerSessionId,
      ownerEpoch: this.ownerEpoch,
      // list() is intentionally active-only; snapshots retain terminal
      // tombstones so stale history cannot resurrect one-shot wakes.
      wakes: Object.freeze([...this.records.values()].map(copySnapshot)),
    });
  }

  /**
   * Restore a complete metadata snapshot transactionally. Queued entries are
   * intentionally not redelivered; an operator must reconcile them explicitly.
   */
  restore(value: unknown): boolean {
    if (this.disposed) throw new Error('Wake coordinator is disposed.');
    const incoming = this.parseSnapshot(value);
    return incoming ? this.applyIncoming(incoming) : false;
  }

  /** Consolidate append-only history before mutating live wake state. */
  restoreHistory(values: readonly unknown[]): boolean {
    if (this.disposed) throw new Error('Wake coordinator is disposed.');
    let ledger = new Map<string, WakeRecord>();
    for (const value of values) {
      const incoming = this.parseSnapshot(value);
      if (!incoming) return false;
      for (const record of incoming.values()) {
        const merged = mergeWakeRestoreRecords(
          ledger,
          new Map([[record.id, record]]),
          WAKE_MAX_SUBSCRIPTIONS,
        );
        if (!merged) return false;
        ledger = merged.records;
      }
    }
    return this.applyIncoming(ledger);
  }

  private parseSnapshot(value: unknown): Map<string, WakeRecord> | undefined {
    return parseWakeRestoreSnapshot(value, {
      version: WAKE_COORDINATOR_VERSION,
      ownerSessionId: this.ownerSessionId,
      ownerEpoch: this.ownerEpoch,
      maxSubscriptions: WAKE_MAX_SUBSCRIPTIONS,
      maxConditionReferences: WAKE_MAX_CONDITION_REFERENCES,
      maxPayloadSelectors: WAKE_MAX_PAYLOAD_SELECTORS,
      wakeIdMaxLength: WAKE_ID_MAX_LENGTH,
      wakeIdPattern: WAKE_ID_PATTERN,
      currentWorkflowLookup: (identity) => this.workflow.get(identity),
    });
  }

  private applyIncoming(incoming: Map<string, WakeRecord>): boolean {
    const merged = mergeWakeRestoreRecords(
      this.records,
      incoming,
      WAKE_MAX_SUBSCRIPTIONS,
    );
    if (!merged) return false;
    this.records.clear();
    for (const [id, record] of merged.records) this.records.set(id, record);
    for (const record of merged.accepted) {
      this.blockReloadOrphan(record);
      this.emit(record);
      this.reevaluate(record);
    }
    return true;
  }

  private blockReloadOrphan(record: WakeRecord): boolean {
    if (
      !needsWakeReloadBlock(
        record,
        (identity) => this.workflow.get(identity),
        WORKFLOW_RELOAD_ORPHAN_REASON,
      )
    )
      return false;
    record.state = 'blocked';
    record.blockedAt = Math.max(
      this.now(),
      record.createdAt,
      record.readyAt ?? 0,
      record.queuedAt ?? 0,
    );
    record.reason = WAKE_RELOAD_ORPHAN_REASON;
    record.payload = undefined;
    return true;
  }

  setDispatchHandler(handler: WakeDispatchHandler | undefined): void {
    this.dispatchHandler = handler;
    if (handler) {
      for (const record of this.records.values()) {
        if (record.state !== 'ready') continue;
        const orphaned = this.blockReloadOrphan(record);
        if (orphaned) this.emit(record);
        else this.queue(record);
      }
    }
  }

  retry(id: string): WakeSnapshot {
    const record = this.requireRecord(id);
    if (record.state !== 'ready')
      throw new Error(`Wake "${id}" is not ready for dispatch retry.`);
    const orphaned = this.blockReloadOrphan(record);
    if (orphaned) this.emit(record);
    else this.queue(record);
    return copySnapshot(record);
  }

  retryDispatch(id: string): WakeSnapshot {
    const record = this.requireRecord(id);
    if (record.state === 'queued') {
      // Explicit reconciliation is the only path that may reconsider a queued
      // delivery after restore or a process crash.
      record.state = 'ready';
      record.payload = undefined;
      this.emit(record);
      if (this.dispatchHandler) this.queue(record);
      return copySnapshot(record);
    }
    return this.retry(id);
  }

  /** Explicit operator recovery for an accepted-but-unentered delivery. */
  recover(id: string): WakeSnapshot {
    const record = this.requireRecord(id);
    if (record.state !== 'queued' && record.state !== 'ready')
      throw new Error(`Wake "${id}" is not recoverable from ${record.state}.`);
    return this.retryDispatch(id);
  }

  reconcileQueued(id: string): WakeSnapshot {
    return this.retryDispatch(id);
  }

  markEntered(id: string, acknowledgement: WakeAcknowledgement): WakeSnapshot {
    const record = this.requireRecord(id);
    this.validateAcknowledgement(acknowledgement);
    if (record.state === 'entered') {
      if (sameAcknowledgement(record.enteredAcknowledgement, acknowledgement))
        return copySnapshot(record);
      throw new Error(`Wake "${id}" acknowledgement is stale.`);
    }
    if (record.state !== 'queued')
      throw new Error(`Wake "${id}" is not queued for entry.`);
    if (
      !sameAcknowledgement(this.currentAcknowledgement(record), acknowledgement)
    )
      throw new Error(`Wake "${id}" acknowledgement is stale.`);
    record.state = 'entered';
    record.enteredAt = this.now();
    record.enteredAcknowledgement = copyAcknowledgement(acknowledgement);
    record.payload = undefined;
    this.emit(record);
    return copySnapshot(record);
  }

  enter(id: string, acknowledgement: WakeAcknowledgement): WakeSnapshot {
    return this.markEntered(id, acknowledgement);
  }

  /** Exact workflow sources whose payloads have entered parent model context. */
  enteredSourceIdentities(): AttemptIdentity[] {
    const sources = new Set<AttemptIdentity>();
    for (const record of this.records.values()) {
      if (record.state !== 'entered' || !record.readyReferences?.length)
        continue;
      for (const selector of record.payloadSelectors) {
        const selected =
          selector.node === undefined
            ? record.readyReferences
            : [selector.node as AttemptIdentity];
        for (const identity of selected) {
          if (record.readyReferences.includes(identity)) sources.add(identity);
        }
      }
    }
    return [...sources];
  }

  cancel(id: string, reason = 'Wake subscription cancelled.'): WakeSnapshot {
    const record = this.requireRecord(id);
    if (isWakeTerminal(record.state)) return copySnapshot(record);
    record.state = 'cancelled';
    record.cancelledAt = this.now();
    record.reason = boundedReason(reason);
    record.payload = undefined;
    record.dispatchGeneration++;
    this.emit(record);
    return copySnapshot(record);
  }

  subscribeChanges(listener: WakeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeWorkflow();
    this.listeners.clear();
  }

  private validateAcknowledgement(acknowledgement: WakeAcknowledgement): void {
    if (
      !acknowledgement ||
      typeof acknowledgement.deliveryKey !== 'string' ||
      !Number.isSafeInteger(acknowledgement.dispatchGeneration) ||
      acknowledgement.dispatchGeneration < 1 ||
      !Number.isSafeInteger(acknowledgement.dispatchAttempt) ||
      acknowledgement.dispatchAttempt < 1
    )
      throw new Error('Invalid wake acknowledgement token.');
  }

  private currentAcknowledgement(record: WakeRecord): WakeAcknowledgement {
    return {
      deliveryKey: deliveryKey(
        record.ownerSessionId,
        record.ownerEpoch,
        record.id,
      ),
      dispatchGeneration: record.dispatchGeneration,
      dispatchAttempt: record.dispatchAttempts,
    };
  }

  private validateId(id: string): void {
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > WAKE_ID_MAX_LENGTH ||
      !WAKE_ID_PATTERN.test(id)
    )
      throw new Error(
        `Invalid wake ID "${String(id)}": use lowercase kebab-case.`,
      );
  }

  private overlapWarnings(
    condition: WakeCondition,
    references: readonly AttemptIdentity[],
    selectors: readonly CanonicalWakePayloadSelector[],
  ): string[] {
    const channels = this.effectivePayloadChannels(
      condition,
      references,
      selectors,
    );
    const warnings: string[] = [];
    for (const existing of this.records.values()) {
      if (isWakeTerminal(existing.state)) continue;
      const existingChannels = this.effectivePayloadChannels(
        existing.condition,
        existing.references,
        existing.payloadSelectors,
      );
      const overlap = [...channels].filter((channel) =>
        existingChannels.has(channel),
      );
      if (overlap.length === 0) continue;
      warnings.push(
        `Wake overlaps subscription "${existing.id}" on ${overlap
          .slice(0, 3)
          .join(', ')}${overlap.length > 3 ? ', …' : ''}.`,
      );
      if (warnings.length >= 2) break;
    }
    return warnings;
  }

  private effectivePayloadChannels(
    condition: WakeCondition,
    references: readonly AttemptIdentity[],
    selectors: readonly CanonicalWakePayloadSelector[],
  ): Set<string> {
    const channels = new Set<string>();
    for (const selector of selectors) {
      const sources =
        selector.node === undefined ? references : [selector.node];
      for (const source of sources)
        channels.add(`${source}:${selector.kind}:${selector.name ?? ''}`);
    }
    // Keep the condition parameter explicit: any's omitted selectors can
    // become any terminal ref, while node/all are exact at readiness.
    if ('any' in condition && condition.any.length > 0) return channels;
    return channels;
  }

  private bindPayloadSelectors(
    selectors: readonly CanonicalWakePayloadSelector[],
    references: readonly AttemptIdentity[],
  ): readonly CanonicalWakePayloadSelector[] {
    const bound = selectors.map((selector) => {
      if (selector.node === undefined) return selector;
      const attempt = this.workflow.require(selector.node);
      if (!references.includes(attempt.identity))
        throw new Error(
          `Wake payload source "${attempt.identity}" is not a condition reference.`,
        );
      return Object.freeze({ ...selector, node: attempt.identity });
    });
    for (let left = 0; left < bound.length; left++)
      for (let right = left + 1; right < bound.length; right++) {
        const first = bound[left];
        const second = bound[right];
        if (!first || !second) continue;
        if (
          first.kind !== second.kind ||
          first.name !== second.name ||
          (first.node !== undefined &&
            second.node !== undefined &&
            first.node !== second.node)
        )
          continue;
        throw new Error('Duplicate wake payload selectors are not allowed.');
      }
    return copyPayloadSelectors(bound);
  }

  private bindCondition(
    condition: WakeCondition,
    references: readonly string[],
  ): WakeCondition {
    if ('node' in condition)
      return Object.freeze({ node: references[0] ?? '' });
    if ('all' in condition)
      return Object.freeze({ all: Object.freeze([...references]) });
    return Object.freeze({ any: Object.freeze([...references]) });
  }

  private requireRecord(id: string): WakeRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown wake ID "${id}".`);
    return record;
  }

  private reevaluatePending(): void {
    for (const record of this.records.values()) this.reevaluate(record);
  }

  private reevaluate(record: WakeRecord): void {
    if (this.blockReloadOrphan(record)) {
      this.emit(record);
      return;
    }
    if (record.state === 'ready' && !record.payload) {
      try {
        record.payload = this.resolvePayload(
          record,
          record.readyReferences ?? this.terminalReferences(record),
        );
      } catch (error) {
        if (error instanceof WakePayloadPendingError) {
          record.state = 'pending';
          record.readyReferences = undefined;
          this.emit(record);
          return;
        }
        record.state = 'blocked';
        record.blockedAt = this.now();
        record.reason = boundedReason(error);
        this.emit(record);
        return;
      }
      if (this.dispatchHandler) this.queue(record);
      return;
    }
    if (record.state !== 'pending') return;
    const terminal = this.terminalReferences(record);
    const satisfied =
      'node' in record.condition
        ? terminal[0] === record.references[0]
        : 'all' in record.condition
          ? terminal.length === record.references.length
          : terminal.length > 0;
    if (!satisfied) return;
    try {
      record.payload = this.resolvePayload(record, terminal);
    } catch (error) {
      if (error instanceof WakePayloadPendingError) return;
      record.state = 'blocked';
      record.blockedAt = this.now();
      record.reason = boundedReason(error);
      this.emit(record);
      return;
    }
    record.readyReferences = Object.freeze([...terminal]);
    record.state = 'ready';
    record.readyAt = this.now();
    this.emit(record);
    if (this.dispatchHandler) this.queue(record);
  }

  private terminalReferences(record: WakeRecord): AttemptIdentity[] {
    return record.references.filter((identity) => {
      const attempt = this.workflow.get(identity);
      return attempt !== undefined && this.isTerminalAttempt(attempt);
    });
  }

  private isTerminalAttempt(attempt: DelegateWorkflowAttemptSnapshot): boolean {
    return isTerminalWorkflowAttemptState(attempt.state);
  }

  private resolvePayload(
    record: WakeRecord,
    readyReferences: readonly AttemptIdentity[],
  ): WakePayload {
    const sourceValues = new Map<AttemptIdentity, WakePayloadSource>();
    const used = new Set<string>();
    for (const selector of record.payloadSelectors) {
      const sources =
        selector.node === undefined ? readyReferences : [selector.node];
      if (sources.length === 0)
        throw new WakePayloadPendingError('Wake payload has no ready source.');
      if (
        selector.node !== undefined &&
        !readyReferences.includes(selector.node)
      )
        throw new WakePayloadPendingError(
          `Wake payload source "${selector.node}" is not terminal yet.`,
        );
      for (const identity of sources) {
        const key = `${identity}:${selector.kind}:${selector.name ?? ''}`;
        if (used.has(key))
          throw new Error('Duplicate wake payload selectors are not allowed.');
        used.add(key);
        const attempt = this.workflow.get(identity);
        if (!attempt || !this.isTerminalAttempt(attempt))
          throw new WakePayloadPendingError(
            `Wake payload source "${identity}" is not terminal yet.`,
          );
        const current = sourceValues.get(identity) ?? {};
        let next: WakePayloadSource;
        if (selector.kind === 'handoff') {
          const handoff =
            this.workflow.getResultEvidence(identity)?.handoff.text;
          if (handoff === undefined)
            throw new Error('Wake handoff payload is unavailable.');
          if (
            Buffer.byteLength(handoff, 'utf8') > WAKE_PAYLOAD_CAPS.handoffBytes
          )
            throw new Error('Wake handoff payload exceeds its bounded limit.');
          next = { ...current, handoff };
        } else {
          const symbolic: SymbolicWorkflowSelector = {
            node: identity,
            include: [selector.kind],
          };
          const bound: BoundWorkflowSelector = Object.freeze({
            selector: Object.freeze(symbolic),
            identity,
          });
          const resolved = this.workflow.resolveBoundWorkflowInputs([bound]);
          const selected = resolved.inputs.find(
            (candidate: ResolvedWorkflowInput) =>
              candidate.kind === selector.kind,
          );
          if (!selected)
            throw new Error(`Wake payload ${selector.kind} is unavailable.`);
          if (
            selected.value === undefined ||
            jsonBytes(selected.value) > WAKE_PAYLOAD_CAPS.metadataBytes
          )
            throw new Error('Wake metadata payload exceeds its bounded limit.');
          next = {
            ...current,
            metadata: cloneAndFreezeWakeJson(selected.value) as Record<
              string,
              unknown
            >,
          };
        }
        sourceValues.set(identity, next);
      }
    }
    const sources = Object.fromEntries(
      [...sourceValues.entries()].map(([identity, source]) => [
        identity,
        Object.freeze(source),
      ]),
    ) as Record<AttemptIdentity, WakePayloadSource>;
    if (jsonBytes(sources) > WAKE_PAYLOAD_CAPS.aggregateBytes)
      throw new Error('Wake payload exceeds its bounded aggregate limit.');
    const frozenSources = Object.freeze(sources);
    const sourceKeys = Object.keys(sources);
    if (sourceKeys.length !== 1)
      return Object.freeze({ sources: frozenSources });
    const only = sources[sourceKeys[0] ?? ''];
    return Object.freeze({
      sources: frozenSources,
      ...(only?.handoff !== undefined ? { handoff: only.handoff } : {}),
      ...(only?.metadata !== undefined ? { metadata: only.metadata } : {}),
    });
  }

  private queue(record: WakeRecord): void {
    if (record.state !== 'ready' || !this.dispatchHandler) return;
    if (!record.payload) {
      try {
        record.payload = this.resolvePayload(
          record,
          record.readyReferences ?? this.terminalReferences(record),
        );
      } catch (error) {
        if (error instanceof WakePayloadPendingError) {
          record.state = 'pending';
          record.readyReferences = undefined;
          this.emit(record);
          return;
        }
        record.state = 'blocked';
        record.blockedAt = this.now();
        record.reason = boundedReason(error);
        this.emit(record);
        return;
      }
    }
    record.state = 'queued';
    record.queuedAt = this.now();
    record.dispatchAttempts++;
    const generation = ++record.dispatchGeneration;
    const payload = record.payload;
    if (!payload) {
      record.state = 'blocked';
      record.blockedAt = this.now();
      record.reason = 'Wake payload was unavailable at dispatch.';
      this.emit(record);
      return;
    }
    this.emit(record);
    if (
      record.state !== 'queued' ||
      record.dispatchGeneration !== generation ||
      !this.dispatchHandler
    )
      return;
    const acknowledgement = copyAcknowledgement(
      this.currentAcknowledgement(record),
    );
    let result: void | Promise<void>;
    try {
      result = this.dispatchHandler({
        wake: copySnapshot(record),
        acknowledgement,
        ownerSessionId: this.ownerSessionId,
        ownerEpoch: this.ownerEpoch,
        deliveryKey: acknowledgement.deliveryKey,
        payload,
      });
    } catch (error) {
      this.dispatchFailed(record, generation, error);
      return;
    }
    void Promise.resolve(result).catch((error) => {
      this.dispatchFailed(record, generation, error);
    });
  }

  private dispatchFailed(
    record: WakeRecord,
    generation: number,
    error: unknown,
  ): void {
    if (record.dispatchGeneration !== generation || record.state !== 'queued')
      return;
    record.state = 'ready';
    record.lastDispatchFailure = boundedReason(error);
    record.reason = record.lastDispatchFailure;
    record.payload = undefined;
    this.emit(record);
  }

  private emit(record: WakeRecord): void {
    record.revision++;
    const snapshot = copySnapshot(record);
    this.onChange?.();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A delivery observer cannot break the one-shot state machine.
      }
    }
  }
}

export function createWakeCoordinator(
  options: WakeCoordinatorOptions,
): WakeCoordinator {
  return new WakeCoordinator(options);
}
