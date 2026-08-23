/** Maximum length of a logical workflow node identifier. */
export const MAX_LOGICAL_ID_LENGTH = 64;

/** Maximum ordinal representable in a public attempt identity. */
export const MAX_ATTEMPT_ORDINAL = 999_999_999;
/** Maximum number of persisted dependency references on one attempt. */
export const MAX_WORKFLOW_DEPENDENCIES = 32;

const LOGICAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXACT_REFERENCE_PATTERN =
  /^(?<logicalId>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)@(?<ordinal>[1-9][0-9]{0,8})$/;

/** A model-owned logical node name, without its attempt ordinal. */
export type LogicalId = string;

/** The coordinator lifecycle of one immutable attempt. */
export type WorkflowAttemptState =
  | 'scheduled'
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'timed-out'
  | 'aborted'
  | 'cancelled'
  | 'blocked';

/** The stable, human-readable identity of one immutable attempt. */
export type AttemptIdentity = string;

export interface WorkflowAttempt {
  readonly logicalId: LogicalId;
  readonly ordinal: number;
  readonly identity: AttemptIdentity;
}

export interface WorkflowModelSnapshot {
  readonly attempts: readonly WorkflowAttempt[];
}

/** A mutation prepared without changing the model. */
export interface WorkflowModelPlan {
  readonly kind: 'fresh' | 'continuation';
  readonly attempt: WorkflowAttempt;
  readonly predecessor?: WorkflowAttempt;
}

const TERMINAL_ATTEMPT_STATES: ReadonlySet<WorkflowAttemptState> = new Set([
  'success',
  'error',
  'timed-out',
  'aborted',
  'cancelled',
  'blocked',
]);

/** Whether an attempt has settled, regardless of whether it succeeded. */
export function isTerminalWorkflowAttemptState(
  state: WorkflowAttemptState,
): boolean {
  return TERMINAL_ATTEMPT_STATES.has(state);
}

/** The legal coordinator transitions for an attempt. */
export function canTransitionWorkflowAttemptState(
  from: WorkflowAttemptState,
  to: WorkflowAttemptState,
): boolean {
  if (from === to) return true;
  if (isTerminalWorkflowAttemptState(from)) return false;
  if (to === 'scheduled') return false;
  if (from === 'scheduled')
    return (
      to === 'queued' ||
      to === 'error' ||
      to === 'cancelled' ||
      to === 'blocked'
    );
  if (from === 'queued')
    return to === 'running' || isTerminalWorkflowAttemptState(to);
  return from === 'running' && isTerminalWorkflowAttemptState(to);
}

/** Assert a lifecycle transition instead of silently accepting stale state. */
export function assertWorkflowAttemptTransition(
  from: WorkflowAttemptState,
  to: WorkflowAttemptState,
): void {
  if (!canTransitionWorkflowAttemptState(from, to))
    throw new Error(`Illegal workflow attempt transition: ${from} -> ${to}.`);
}

function invalidLogicalId(logicalId: string): Error {
  return new Error(
    `Invalid logical ID "${logicalId}": use 1-${MAX_LOGICAL_ID_LENGTH} lowercase kebab-case characters.`,
  );
}

function assertLogicalId(logicalId: string): void {
  if (
    logicalId.length === 0 ||
    logicalId.length > MAX_LOGICAL_ID_LENGTH ||
    !LOGICAL_ID_PATTERN.test(logicalId)
  )
    throw invalidLogicalId(logicalId);
}

/** Validate a logical ID without creating it. */
export function isLogicalId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_LOGICAL_ID_LENGTH &&
    LOGICAL_ID_PATTERN.test(value)
  );
}

/** Whether a value is a canonical UUID accepted by durable process hosts. */
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_PATTERN.test(value);
}

/** Whether a value is a canonical exact attempt identity. */
export function isCanonicalWorkflowAttemptReference(
  value: unknown,
): value is AttemptIdentity {
  if (typeof value !== 'string') return false;
  const exact = EXACT_REFERENCE_PATTERN.exec(value);
  if (!exact?.groups) return false;
  const logicalId = exact.groups.logicalId;
  const ordinal = Number(exact.groups.ordinal);
  return (
    ordinal <= MAX_ATTEMPT_ORDINAL &&
    isLogicalId(logicalId) &&
    value === `${logicalId}@${ordinal}`
  );
}

/** Parse a reference while preserving the distinction between bare and exact forms. */
export function parseWorkflowReference(reference: string): {
  logicalId: LogicalId;
  ordinal?: number;
} {
  if (isLogicalId(reference)) return { logicalId: reference };
  const exact = EXACT_REFERENCE_PATTERN.exec(reference);
  if (exact?.groups) {
    const logicalId = exact.groups.logicalId;
    const ordinal = Number(exact.groups.ordinal);
    if (ordinal <= MAX_ATTEMPT_ORDINAL && isLogicalId(logicalId))
      return { logicalId, ordinal };
  }
  throw new Error(
    `Invalid workflow reference "${reference}": use logical-id or logical-id@ordinal.`,
  );
}

function copyAttempt(attempt: WorkflowAttempt): WorkflowAttempt {
  return Object.freeze({ ...attempt });
}

/** Validate and detach an attempt received at an adapter boundary. */
export function normalizeWorkflowAttempt(value: unknown): WorkflowAttempt {
  if (value === null || typeof value !== 'object')
    throw new Error('Invalid workflow attempt: expected an attempt object.');
  const candidate = value as {
    logicalId?: unknown;
    ordinal?: unknown;
    identity?: unknown;
  };
  if (
    typeof candidate.logicalId !== 'string' ||
    !isLogicalId(candidate.logicalId) ||
    typeof candidate.ordinal !== 'number' ||
    !Number.isSafeInteger(candidate.ordinal) ||
    candidate.ordinal < 1 ||
    candidate.ordinal > MAX_ATTEMPT_ORDINAL ||
    candidate.identity !== `${candidate.logicalId}@${candidate.ordinal}`
  )
    throw new Error(
      'Invalid workflow attempt: logical ID, ordinal, and identity must agree.',
    );
  return Object.freeze({
    logicalId: candidate.logicalId,
    ordinal: candidate.ordinal,
    identity: candidate.identity,
  });
}

/**
 * Session-scoped identity model for logical workflow nodes and immutable
 * attempts. It deliberately owns no execution or job lifecycle state.
 */
export class WorkflowModel {
  private readonly attemptsByLogicalId = new Map<
    LogicalId,
    WorkflowAttempt[]
  >();
  private readonly attempts: WorkflowAttempt[] = [];

  /** Prepare the first attempt for a logical node without mutating identity state. */
  planFresh(logicalId: LogicalId): WorkflowModelPlan {
    assertLogicalId(logicalId);
    if (this.attemptsByLogicalId.has(logicalId))
      throw new Error(
        `Logical ID "${logicalId}" already exists; continue it instead of creating it again.`,
      );
    return Object.freeze({
      kind: 'fresh',
      attempt: Object.freeze({
        logicalId,
        ordinal: 1,
        identity: `${logicalId}@1`,
      }),
    });
  }

  /** Prepare the next immutable attempt without mutating identity state. */
  planContinuation(reference: string): WorkflowModelPlan {
    const parsed = parseWorkflowReference(reference);
    const logicalId = parsed.logicalId;
    const lineage = this.attemptsByLogicalId.get(logicalId);
    if (!lineage)
      throw new Error(
        `Unknown logical ID "${logicalId}"; create it before continuing.`,
      );
    const predecessor = lineage[lineage.length - 1];
    if (!predecessor)
      throw new Error(`Logical ID "${logicalId}" has no attempts.`);
    if (parsed.ordinal !== undefined && parsed.ordinal !== predecessor.ordinal)
      throw new Error(
        `Cannot continue ${reference}; ${logicalId} latest attempt is ${predecessor.identity}.`,
      );
    if (predecessor.ordinal >= MAX_ATTEMPT_ORDINAL)
      throw new Error(
        `Logical ID "${logicalId}" has reached its attempt limit.`,
      );
    const attempt = {
      logicalId,
      ordinal: predecessor.ordinal + 1,
      identity: `${logicalId}@${predecessor.ordinal + 1}`,
    };
    return Object.freeze({
      kind: 'continuation',
      attempt: Object.freeze(attempt),
      predecessor: copyAttempt(predecessor),
    });
  }

  /** Commit a previously prepared mutation after all adapter validation passes. */
  commit(plan: WorkflowModelPlan): WorkflowAttempt {
    const attempt = normalizeWorkflowAttempt(plan.attempt);
    const lineage = this.attemptsByLogicalId.get(attempt.logicalId);
    if (plan.kind === 'fresh') {
      if (lineage)
        throw new Error(
          `Logical ID "${attempt.logicalId}" already exists; cannot commit a fresh attempt.`,
        );
      if (attempt.ordinal !== 1)
        throw new Error('Invalid fresh workflow model plan.');
    } else {
      const predecessor = plan.predecessor;
      const latest = lineage?.[lineage.length - 1];
      if (!predecessor || !latest || latest.identity !== predecessor.identity)
        throw new Error(
          `Workflow model changed before continuing "${attempt.logicalId}".`,
        );
      if (attempt.ordinal !== latest.ordinal + 1)
        throw new Error('Invalid continuation workflow model plan.');
    }
    return this.addAttempt(attempt.logicalId, attempt.ordinal);
  }

  /** Create the first attempt for a logical node. */
  createFresh(logicalId: LogicalId): WorkflowAttempt {
    return this.commit(this.planFresh(logicalId));
  }

  /** Create the next immutable attempt in an existing lineage. */
  continue(logicalId: LogicalId): WorkflowAttempt {
    return this.commit(this.planContinuation(logicalId));
  }

  /** Bind a bare reference now, or resolve an exact reference immutably. */
  bind(reference: string): WorkflowAttempt {
    const parsed = parseWorkflowReference(reference);
    const lineage = this.attemptsByLogicalId.get(parsed.logicalId);
    if (!lineage)
      throw new Error(
        `Unknown logical ID "${parsed.logicalId}"; create it before binding.`,
      );
    if (parsed.ordinal === undefined) {
      const latest = lineage[lineage.length - 1];
      if (!latest)
        throw new Error(`Logical ID "${parsed.logicalId}" has no attempts.`);
      return copyAttempt(latest);
    }
    const attempt = lineage[parsed.ordinal - 1];
    if (!attempt)
      throw new Error(
        `Unknown attempt "${reference}"; continue the lineage to create it.`,
      );
    return copyAttempt(attempt);
  }

  /** Resolve an already-created reference; equivalent to bind for this model. */
  lookup(reference: string): WorkflowAttempt {
    return this.bind(reference);
  }

  /**
   * Import an attempt that was persisted on an ancestor branch. Imported
   * attempts retain their public identity but do not create a new ordinal.
   */
  importAttempt(value: WorkflowAttempt): WorkflowAttempt {
    const attempt = normalizeWorkflowAttempt(value);
    const existing = this.attemptsByLogicalId.get(attempt.logicalId) ?? [];
    const duplicate = existing.find(
      (candidate) => candidate.ordinal === attempt.ordinal,
    );
    if (duplicate) {
      if (duplicate.identity !== attempt.identity)
        throw new Error('Conflicting imported workflow attempt identity.');
      return copyAttempt(duplicate);
    }
    const latest = existing.at(-1);
    if (latest && attempt.ordinal !== latest.ordinal + 1)
      throw new Error(
        `Cannot import workflow attempt ${attempt.identity} without its predecessor.`,
      );
    if (!latest && attempt.ordinal !== 1)
      throw new Error(
        `Cannot import workflow attempt ${attempt.identity} without its first attempt.`,
      );
    return this.addAttempt(attempt.logicalId, attempt.ordinal);
  }

  /** Return detached, immutable records in creation order. */
  snapshot(): WorkflowModelSnapshot {
    return Object.freeze({
      attempts: Object.freeze(this.attempts.map(copyAttempt)),
    });
  }

  private addAttempt(logicalId: LogicalId, ordinal: number): WorkflowAttempt {
    const attempt = Object.freeze({
      logicalId,
      ordinal,
      identity: `${logicalId}@${ordinal}`,
    });
    const lineage = this.attemptsByLogicalId.get(logicalId) ?? [];
    lineage.push(attempt);
    this.attemptsByLogicalId.set(logicalId, lineage);
    this.attempts.push(attempt);
    return copyAttempt(attempt);
  }
}

export function createWorkflowModel(): WorkflowModel {
  return new WorkflowModel();
}
