/** Bounded delegate history contracts for dashboard APIs. */
import { type Static, Type } from 'typebox';

import {
  MAX_DELEGATE_HISTORY_CONTEXT_NOTE,
  MAX_DELEGATE_HISTORY_DETAIL_ENTRIES,
  MAX_DELEGATE_HISTORY_DETAIL_TEXT,
  MAX_DELEGATE_HISTORY_GROUPS,
  MAX_DELEGATE_HISTORY_INPUT_EVIDENCE,
  MAX_DELEGATE_HISTORY_PROMPT,
  MAX_DELEGATE_HISTORY_RUNS_PER_GROUP,
  MAX_DELEGATE_HISTORY_TASK,
  MAX_ID,
  MAX_PATH,
} from './limits.js';
import { DelegateWorkflowMetadataSchema } from './workflow-contracts.js';

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: MAX_ID,
  pattern: '^[^\u0000-\u001F\u007F]*$',
});
const FiniteNumberSchema = Type.Number();

/** Payload-free lifecycle metadata projected from delegate-wake:v1 entries. */
export const DelegateWakeMetadataSchema = Type.Object(
  {
    id: IdentifierSchema,
    state: Type.Union([
      Type.Literal('pending'),
      Type.Literal('ready'),
      Type.Literal('queued'),
      Type.Literal('entered'),
      Type.Literal('cancelled'),
      Type.Literal('blocked'),
    ]),
    references: Type.Readonly(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
        maxItems: 32,
      }),
    ),
    createdAt: FiniteNumberSchema,
    readyAt: Type.Optional(FiniteNumberSchema),
    queuedAt: Type.Optional(FiniteNumberSchema),
    enteredAt: Type.Optional(FiniteNumberSchema),
    cancelledAt: Type.Optional(FiniteNumberSchema),
    blockedAt: Type.Optional(FiniteNumberSchema),
    revision: Type.Integer({ minimum: 0 }),
    dispatchAttempts: Type.Integer({ minimum: 0 }),
    reason: Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type DelegateWakeMetadata = Static<typeof DelegateWakeMetadataSchema>;

const DelegateHistoryStateSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('success'),
  Type.Literal('error'),
  Type.Literal('aborted'),
  Type.Literal('timed-out'),
  Type.Literal('scheduled'),
  Type.Literal('cancelled'),
  Type.Literal('blocked'),
]);
export type DelegateHistoryState = Static<typeof DelegateHistoryStateSchema>;
const DelegateHistoryKindSchema = Type.Union([
  Type.Literal('foreground'),
  Type.Literal('background'),
]);
export type DelegateHistoryKind = Static<typeof DelegateHistoryKindSchema>;
const DelegateHistoryScalarSchema = Type.Union([
  Type.String({ maxLength: MAX_DELEGATE_HISTORY_DETAIL_TEXT }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
function delegateHistoryValueSchema(
  depth: number,
): ReturnType<typeof Type.Union> {
  if (depth <= 0) return DelegateHistoryScalarSchema;
  const child = delegateHistoryValueSchema(depth - 1);
  return Type.Union([
    DelegateHistoryScalarSchema,
    Type.Array(child, { maxItems: 32 }),
    Type.Record(Type.String({ maxLength: 128 }), child, { maxProperties: 32 }),
  ]);
}
const DelegateHistoryValueSchema = delegateHistoryValueSchema(6);
const DelegateHistoryActivitySchema = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    type: Type.Union([Type.Literal('thinking'), Type.Literal('tool')]),
    label: Type.String({ minLength: 1, maxLength: 2_000 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    text: Type.Optional(
      Type.String({ maxLength: MAX_DELEGATE_HISTORY_DETAIL_TEXT }),
    ),
    arguments: Type.Optional(DelegateHistoryValueSchema),
    result: Type.Optional(DelegateHistoryValueSchema),
    argumentsTruncated: Type.Optional(Type.Boolean()),
    resultTruncated: Type.Optional(Type.Boolean()),
    status: Type.Optional(
      Type.Union([
        Type.Literal('running'),
        Type.Literal('completed'),
        Type.Literal('error'),
      ]),
    ),
    at: Type.Optional(FiniteNumberSchema),
  },
  { additionalProperties: false },
);
const DelegateHistoryLifecycleSchema = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 128 }),
    diagnostic: Type.Optional(
      Type.String({ maxLength: MAX_DELEGATE_HISTORY_DETAIL_TEXT }),
    ),
    continuationUsable: Type.Boolean(),
    writableBranchRetained: Type.Boolean(),
    readOnlySnapshotRetained: Type.Boolean(),
  },
  { additionalProperties: false },
);
const DelegateHistoryIsolationSchema = Type.Union([
  Type.Literal('shared'),
  Type.Literal('worktree'),
]);
const DelegateHistorySetupSchema = Type.Object(
  {
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PATH })),
    isolation: Type.Optional(DelegateHistoryIsolationSchema),
    worktree: Type.Optional(
      Type.Object(
        {
          branch: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          worktreePath: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_PATH }),
          ),
          repositoryRoot: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_PATH }),
          ),
          baseHead: Type.Optional(
            Type.String({ minLength: 1, maxLength: 256 }),
          ),
          baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          workBase: Type.Optional(
            Type.String({ minLength: 1, maxLength: 256 }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const DelegateHistoryInputEvidenceSchema = Type.Object(
  {
    /** Technical identity stays inside an expandable evidence row. */
    identity: Type.String({ minLength: 1, maxLength: 80 }),
    kind: Type.Union([
      Type.Literal('report'),
      Type.Literal('handoff'),
      Type.Literal('branch'),
      Type.Literal('metadata'),
    ]),
    label: Type.String({ minLength: 1, maxLength: 120 }),
    content: Type.Optional(
      Type.String({ maxLength: MAX_DELEGATE_HISTORY_INPUT_EVIDENCE }),
    ),
    branch: Type.Optional(
      Type.Object(
        {
          branch: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          worktreePath: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_PATH }),
          ),
          base: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          headCommit: Type.Optional(
            Type.String({ minLength: 1, maxLength: 256 }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const DelegateHistoryRunConfigSchema = Type.Object(
  {
    scope: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: MAX_PATH }), {
        maxItems: 128,
      }),
    ),
    after: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
        maxItems: 32,
      }),
    ),
    inputs: Type.Optional(
      Type.Readonly(
        Type.Array(DelegateHistoryInputEvidenceSchema, { maxItems: 8 }),
      ),
    ),
    parentContextNote: Type.Optional(
      Type.String({ maxLength: MAX_DELEGATE_HISTORY_CONTEXT_NOTE }),
    ),
    refreshSource: Type.Optional(
      Type.Union([Type.Literal('wip'), Type.Literal('head')]),
    ),
    warnings: Type.Optional(
      Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 }),
    ),
  },
  { additionalProperties: false },
);
const DelegateHistoryDetailsSchema = Type.Object(
  {
    task: Type.Optional(Type.String({ maxLength: MAX_DELEGATE_HISTORY_TASK })),
    setup: Type.Optional(DelegateHistorySetupSchema),
    runConfig: Type.Optional(DelegateHistoryRunConfigSchema),
    /** Exact final prompt passed to the child for this invocation. */
    renderedPrompt: Type.Optional(
      Type.String({ maxLength: MAX_DELEGATE_HISTORY_PROMPT }),
    ),
    /** Bounded assistant response text from public run messages only. */
    response: Type.Optional(
      Type.String({ maxLength: MAX_DELEGATE_HISTORY_DETAIL_TEXT }),
    ),
    /** Bounded public run error; stderr is intentionally never persisted here. */
    error: Type.Optional(
      Type.String({ maxLength: MAX_DELEGATE_HISTORY_DETAIL_TEXT }),
    ),
    activities: Type.Optional(
      Type.Readonly(
        Type.Array(DelegateHistoryActivitySchema, {
          maxItems: MAX_DELEGATE_HISTORY_DETAIL_ENTRIES,
        }),
      ),
    ),
    lifecycle: Type.Optional(DelegateHistoryLifecycleSchema),
    warnings: Type.Optional(
      Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 }),
    ),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type DelegateHistoryDetails = Static<
  typeof DelegateHistoryDetailsSchema
>;

const MAX_DELEGATE_USAGE_VALUE = Number.MAX_SAFE_INTEGER;
export const DelegateUsageSchema = Type.Object(
  {
    input: Type.Integer({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    output: Type.Integer({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    cacheRead: Type.Integer({
      minimum: 0,
      maximum: MAX_DELEGATE_USAGE_VALUE,
    }),
    cacheWrite: Type.Integer({
      minimum: 0,
      maximum: MAX_DELEGATE_USAGE_VALUE,
    }),
    contextTokens: Type.Integer({
      minimum: 0,
      maximum: MAX_DELEGATE_USAGE_VALUE,
    }),
    cost: Type.Number({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    turns: Type.Integer({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    contextWindow: Type.Optional(
      Type.Integer({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    ),
  },
  { additionalProperties: false },
);
export type DelegateUsage = Static<typeof DelegateUsageSchema>;

/** Project untrusted persisted or runtime usage into the bounded wire shape. */
export function projectDelegateUsage(
  value: unknown,
): DelegateUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  const integer = (name: string): number | undefined => {
    const candidate = source[name];
    return typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
      ? candidate
      : undefined;
  };
  const cost = source.cost;
  const input = integer('input');
  const output = integer('output');
  const cacheRead = integer('cacheRead');
  const cacheWrite = integer('cacheWrite');
  const contextTokens = integer('contextTokens');
  const turns = integer('turns');
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    contextTokens === undefined ||
    typeof cost !== 'number' ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    cost > MAX_DELEGATE_USAGE_VALUE ||
    turns === undefined
  )
    return undefined;
  const contextWindow = integer('contextWindow');
  if (
    input === 0 &&
    output === 0 &&
    cacheRead === 0 &&
    cacheWrite === 0 &&
    contextTokens === 0 &&
    cost === 0 &&
    turns === 0 &&
    contextWindow === undefined
  )
    return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    contextTokens,
    cost,
    turns,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

const DelegateHistoryInvocationSchema = Type.Object(
  {
    runId: IdentifierSchema,
    /** Missing only for legacy delegate records. */
    sessionId: Type.Optional(IdentifierSchema),
    lineageId: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 2_000 }),
    /** Task is run metadata; transcript/activity payloads are detail-only. */
    task: Type.Optional(Type.String({ maxLength: MAX_DELEGATE_HISTORY_TASK })),
    kind: DelegateHistoryKindSchema,
    state: DelegateHistoryStateSchema,
    createdAt: FiniteNumberSchema,
    queuedAt: Type.Optional(FiniteNumberSchema),
    startedAt: Type.Optional(FiniteNumberSchema),
    finishedAt: Type.Optional(FiniteNumberSchema),
    usage: Type.Optional(DelegateUsageSchema),
    jobId: Type.Optional(IdentifierSchema),
    route: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    context: Type.Optional(
      Type.Union([
        Type.Literal('branch'),
        Type.Literal('fresh'),
        Type.Literal('continuation'),
      ]),
    ),
    allowWrites: Type.Boolean(),
    capabilities: Type.Optional(
      Type.Readonly(
        Type.Array(Type.Literal('web'), { maxItems: 1, uniqueItems: true }),
      ),
    ),
    isolation: Type.Optional(DelegateHistoryIsolationSchema),
    workflow: Type.Optional(DelegateWorkflowMetadataSchema),
    wake: Type.Optional(DelegateWakeMetadataSchema),
  },
  { additionalProperties: false },
);
export type DelegateHistoryInvocation = Static<
  typeof DelegateHistoryInvocationSchema
>;

/** One selected invocation with its bounded, public transcript payload. */
export const DelegateHistoryRunDetailSchema = Type.Object(
  {
    runId: IdentifierSchema,
    /** Missing only for legacy delegate records. */
    sessionId: Type.Optional(IdentifierSchema),
    lineageId: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 2_000 }),
    task: Type.Optional(Type.String({ maxLength: MAX_DELEGATE_HISTORY_TASK })),
    kind: DelegateHistoryKindSchema,
    state: DelegateHistoryStateSchema,
    createdAt: FiniteNumberSchema,
    queuedAt: Type.Optional(FiniteNumberSchema),
    startedAt: Type.Optional(FiniteNumberSchema),
    finishedAt: Type.Optional(FiniteNumberSchema),
    usage: Type.Optional(DelegateUsageSchema),
    jobId: Type.Optional(IdentifierSchema),
    route: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    context: Type.Optional(
      Type.Union([
        Type.Literal('branch'),
        Type.Literal('fresh'),
        Type.Literal('continuation'),
      ]),
    ),
    allowWrites: Type.Boolean(),
    capabilities: Type.Optional(
      Type.Readonly(
        Type.Array(Type.Literal('web'), { maxItems: 1, uniqueItems: true }),
      ),
    ),
    isolation: Type.Optional(DelegateHistoryIsolationSchema),
    workflow: Type.Optional(DelegateWorkflowMetadataSchema),
    wake: Type.Optional(DelegateWakeMetadataSchema),
    details: DelegateHistoryDetailsSchema,
  },
  { additionalProperties: false },
);
export type DelegateHistoryRunDetail = Static<
  typeof DelegateHistoryRunDetailSchema
>;

const DelegateHistoryGroupSchema = Type.Object(
  {
    /** Stable lineage row identity; unlike live status IDs this survives reload. */
    id: IdentifierSchema,
    runId: IdentifierSchema,
    /** Child session of the currently selected invocation, when retained. */
    sessionId: Type.Optional(IdentifierSchema),
    lineageId: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 2_000 }),
    kind: DelegateHistoryKindSchema,
    state: DelegateHistoryStateSchema,
    createdAt: FiniteNumberSchema,
    startedAt: Type.Optional(FiniteNumberSchema),
    finishedAt: Type.Optional(FiniteNumberSchema),
    jobId: Type.Optional(IdentifierSchema),
    route: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    context: Type.Optional(
      Type.Union([
        Type.Literal('branch'),
        Type.Literal('fresh'),
        Type.Literal('continuation'),
      ]),
    ),
    allowWrites: Type.Boolean(),
    capabilities: Type.Optional(
      Type.Readonly(
        Type.Array(Type.Literal('web'), { maxItems: 1, uniqueItems: true }),
      ),
    ),
    isolation: Type.Optional(DelegateHistoryIsolationSchema),
    workflow: Type.Optional(DelegateWorkflowMetadataSchema),
    wake: Type.Optional(DelegateWakeMetadataSchema),
    runCount: Type.Integer({
      minimum: 1,
      maximum: MAX_DELEGATE_HISTORY_RUNS_PER_GROUP,
    }),
    runs: Type.Readonly(
      Type.Array(DelegateHistoryInvocationSchema, {
        maxItems: MAX_DELEGATE_HISTORY_RUNS_PER_GROUP,
      }),
    ),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type DelegateHistoryGroup = Static<typeof DelegateHistoryGroupSchema>;

/** Version 2 deliberately contains metadata only; details are fetched per run. */
export const DelegateHistoryResponseSchema = Type.Object(
  {
    version: Type.Literal(2),
    sessionId: IdentifierSchema,
    leafId: Type.Optional(IdentifierSchema),
    truncated: Type.Optional(Type.Boolean()),
    groups: Type.Readonly(
      Type.Array(DelegateHistoryGroupSchema, {
        maxItems: MAX_DELEGATE_HISTORY_GROUPS,
      }),
    ),
  },
  { additionalProperties: false },
);
export type DelegateHistoryResponse = Static<
  typeof DelegateHistoryResponseSchema
>;

export const DelegateHistoryRunQuerySchema = Type.Object(
  {
    lineageId: Type.Optional(IdentifierSchema),
    leafId: Type.Optional(IdentifierSchema),
  },
  { additionalProperties: false },
);
export type DelegateHistoryRunQuery = Static<
  typeof DelegateHistoryRunQuerySchema
>;

export const DelegateHistoryRunDetailResponseSchema = Type.Object(
  {
    version: Type.Literal(1),
    sessionId: IdentifierSchema,
    leafId: Type.Optional(IdentifierSchema),
    lineageId: IdentifierSchema,
    runId: IdentifierSchema,
    run: DelegateHistoryRunDetailSchema,
  },
  { additionalProperties: false },
);
export type DelegateHistoryRunDetailResponse = Static<
  typeof DelegateHistoryRunDetailResponseSchema
>;
/** Compatibility-friendly descriptive aliases for the selected-run response. */
export const DelegateHistoryDetailResponseSchema =
  DelegateHistoryRunDetailResponseSchema;
export type DelegateHistoryDetailResponse = DelegateHistoryRunDetailResponse;

export const SessionDelegateHistoryResponseSchema =
  DelegateHistoryResponseSchema;
export type SessionDelegateHistoryResponse = DelegateHistoryResponse;
