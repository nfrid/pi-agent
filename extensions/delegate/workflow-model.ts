/** Maximum length of a logical workflow node identifier. */
export const MAX_LOGICAL_ID_LENGTH = 64;

/** Maximum ordinal representable in a public attempt identity. */
export const MAX_ATTEMPT_ORDINAL = 999_999_999;

const LOGICAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EXACT_REFERENCE_PATTERN =
  /^(?<logicalId>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)@(?<ordinal>[1-9][0-9]{0,8})$/;

/** A model-owned logical node name, without its attempt ordinal. */
export type LogicalId = string;

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

  /** Create the first attempt for a logical node. */
  createFresh(logicalId: LogicalId): WorkflowAttempt {
    assertLogicalId(logicalId);
    if (this.attemptsByLogicalId.has(logicalId))
      throw new Error(
        `Logical ID "${logicalId}" already exists; continue it instead of creating it again.`,
      );
    return this.addAttempt(logicalId, 1);
  }

  /** Create the next immutable attempt in an existing lineage. */
  continue(logicalId: LogicalId): WorkflowAttempt {
    assertLogicalId(logicalId);
    const lineage = this.attemptsByLogicalId.get(logicalId);
    if (!lineage)
      throw new Error(
        `Unknown logical ID "${logicalId}"; create it before continuing.`,
      );
    const latest = lineage[lineage.length - 1];
    if (!latest) throw new Error(`Logical ID "${logicalId}" has no attempts.`);
    if (latest.ordinal >= MAX_ATTEMPT_ORDINAL)
      throw new Error(
        `Logical ID "${logicalId}" has reached its attempt limit.`,
      );
    return this.addAttempt(logicalId, latest.ordinal + 1);
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
