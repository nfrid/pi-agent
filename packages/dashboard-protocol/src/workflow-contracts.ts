/** Bounded workflow metadata shared by live delegate and history contracts. */
import { type Static, Type } from 'typebox';

import { MAX_ID } from './limits.js';

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: MAX_ID,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$',
});
const FiniteNumberSchema = Type.Number();

/** Canonical workflow identity bounds shared by dashboard consumers. */
export const MAX_WORKFLOW_LOGICAL_ID_LENGTH = 64;
export const MAX_WORKFLOW_ATTEMPT_ORDINAL = 999_999_999;
export const MAX_WORKFLOW_DEPENDENCIES = 32;
const WORKFLOW_LOGICAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WORKFLOW_ATTEMPT_REFERENCE_PATTERN =
  /^(?<logicalId>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)@(?<ordinal>[1-9][0-9]{0,8})$/;

export function isCanonicalWorkflowLogicalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_WORKFLOW_LOGICAL_ID_LENGTH &&
    WORKFLOW_LOGICAL_ID_PATTERN.test(value)
  );
}

export function isCanonicalWorkflowAttemptReference(
  value: unknown,
): value is string {
  if (typeof value !== 'string') return false;
  const match = WORKFLOW_ATTEMPT_REFERENCE_PATTERN.exec(value);
  if (!match?.groups) return false;
  const logicalId = match.groups.logicalId;
  const ordinal = Number(match.groups.ordinal);
  return (
    isCanonicalWorkflowLogicalId(logicalId) &&
    ordinal <= MAX_WORKFLOW_ATTEMPT_ORDINAL &&
    value === `${logicalId}@${ordinal}`
  );
}

const WorkflowLogicalIdSchema = Type.String({
  minLength: 1,
  maxLength: MAX_WORKFLOW_LOGICAL_ID_LENGTH,
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
});
const WorkflowAttemptReferenceSchema = Type.String({
  minLength: 3,
  maxLength: MAX_WORKFLOW_LOGICAL_ID_LENGTH + 1 + 9,
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*@[1-9][0-9]{0,8}$',
});
const DelegateWorkflowStateSchema = Type.Union([
  Type.Literal('scheduled'),
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('success'),
  Type.Literal('error'),
  Type.Literal('timed-out'),
  Type.Literal('aborted'),
  Type.Literal('cancelled'),
  Type.Literal('blocked'),
]);
const DelegateWorkflowInputSchema = Type.Object(
  {
    node: WorkflowLogicalIdSchema,
    identity: WorkflowAttemptReferenceSchema,
    include: Type.Optional(
      Type.Readonly(
        Type.Array(
          Type.Union([
            Type.Literal('report'),
            Type.Literal('handoff'),
            Type.Literal('branch'),
            Type.Literal('metadata'),
          ]),
          { maxItems: 4 },
        ),
      ),
    ),
    label: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { additionalProperties: false },
);
export const DelegateWorkflowMetadataSchema = Type.Object(
  {
    /** Immutable branch owner used to disambiguate identical logical attempts. */
    ownerBranchId: Type.Optional(IdentifierSchema),
    /** Missing only for legacy workflow records. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    logicalId: WorkflowLogicalIdSchema,
    attempt: Type.Integer({
      minimum: 1,
      maximum: MAX_WORKFLOW_ATTEMPT_ORDINAL,
    }),
    identity: WorkflowAttemptReferenceSchema,
    state: DelegateWorkflowStateSchema,
    dependencies: Type.Readonly(
      Type.Array(WorkflowAttemptReferenceSchema, {
        maxItems: MAX_WORKFLOW_DEPENDENCIES,
      }),
    ),
    waitingFor: Type.Optional(
      Type.Readonly(
        Type.Array(WorkflowAttemptReferenceSchema, {
          maxItems: MAX_WORKFLOW_DEPENDENCIES,
        }),
      ),
    ),
    inputs: Type.Optional(
      Type.Readonly(Type.Array(DelegateWorkflowInputSchema, { maxItems: 4 })),
    ),
    reason: Type.Optional(Type.String({ maxLength: 256 })),
    route: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    allowWrites: Type.Optional(Type.Boolean()),
    capabilities: Type.Optional(
      Type.Readonly(
        Type.Array(Type.Literal('web'), { maxItems: 1, uniqueItems: true }),
      ),
    ),
    createdAt: FiniteNumberSchema,
    scheduledAt: FiniteNumberSchema,
    queuedAt: Type.Optional(FiniteNumberSchema),
    startedAt: Type.Optional(FiniteNumberSchema),
    settledAt: Type.Optional(FiniteNumberSchema),
    branchAvailable: Type.Optional(Type.Boolean()),
    snapshotAvailable: Type.Optional(Type.Boolean()),
    deliveredToParent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type DelegateWorkflowMetadata = Static<
  typeof DelegateWorkflowMetadataSchema
>;
