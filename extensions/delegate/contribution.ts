import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  type RendererDescriptor,
} from '@pi-dashboard/extension-contributions';
import { type Static, type TSchema, Type } from 'typebox';

export const DELEGATE_CAPABILITY_ID = 'delegate.live-status';
export const DELEGATE_RENDERER_ID = 'delegate.status';
export const DELEGATE_SURFACE_ID = 'delegate.status';

const DelegateRunStateSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('success'),
  Type.Literal('error'),
  Type.Literal('aborted'),
  Type.Literal('timed-out'),
]);
const DelegateLifecycleReasonSchema = Type.Union([
  Type.Literal('user-cancellation'),
  Type.Literal('queued-cancellation'),
  Type.Literal('timeout'),
  Type.Literal('child-nonzero-exit'),
  Type.Literal('provider-runner-error'),
  Type.Literal('setup-failure'),
  Type.Literal('lifecycle-cleanup-failure'),
  Type.Literal('child-result-invalid'),
  Type.Literal('unknown'),
]);
const DelegateLifecycleSchema = Type.Object(
  {
    reason: DelegateLifecycleReasonSchema,
    diagnostic: Type.Optional(Type.String({ maxLength: 65_536 })),
    diagnosticArtifact: Type.Optional(
      Type.Record(Type.String(), Type.Unknown()),
    ),
    continuationUsable: Type.Boolean(),
    writableBranchRetained: Type.Boolean(),
    readOnlySnapshotRetained: Type.Boolean(),
  },
  { additionalProperties: false },
);
const DelegateActivitySchema = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    type: Type.Union([Type.Literal('thinking'), Type.Literal('tool')]),
    label: Type.String({ maxLength: 2_000 }),
    status: Type.Union([
      Type.Literal('running'),
      Type.Literal('completed'),
      Type.Literal('error'),
    ]),
    latestText: Type.Optional(Type.String({ maxLength: 10_000 })),
  },
  { additionalProperties: false },
);
const DelegateTimingSchema = Type.Object(
  {
    state: DelegateRunStateSchema,
    startedAt: Type.Optional(Type.Number()),
    finishedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);
const DelegateResultSchema = Type.Object(
  {
    kind: Type.Literal('structured'),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('valid'),
      Type.Literal('invalid'),
    ]),
  },
  { additionalProperties: false },
);
const DelegateTranscriptPayloadScalarSchema = Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number(),
  Type.String({ maxLength: 1_024 }),
]);

/** Mirror the four-level, sixteen-item source payload cap in the wire schema. */
function delegateTranscriptPayloadSchema(value: TSchema) {
  return Type.Union([
    DelegateTranscriptPayloadScalarSchema,
    Type.Array(value, { maxItems: 16 }),
    Type.Record(Type.String({ maxLength: 128 }), value, { maxProperties: 16 }),
  ]);
}

const DelegateTranscriptPayloadSchema = delegateTranscriptPayloadSchema(
  delegateTranscriptPayloadSchema(
    delegateTranscriptPayloadSchema(
      delegateTranscriptPayloadSchema(DelegateTranscriptPayloadScalarSchema),
    ),
  ),
);

const DelegateTranscriptEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 512 }),
    type: Type.Union([
      Type.Literal('task'),
      Type.Literal('thinking'),
      Type.Literal('tool'),
      Type.Literal('assistant'),
      Type.Literal('error'),
    ]),
    label: Type.String({ minLength: 1, maxLength: 2_000 }),
    /** Canonical tool name when this is a tool entry. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    /** Bounded tool input captured at tool start, never inferred from labels. */
    arguments: Type.Optional(DelegateTranscriptPayloadSchema),
    /** Bounded final tool output captured at tool end. */
    result: Type.Optional(DelegateTranscriptPayloadSchema),
    argumentsTruncated: Type.Optional(Type.Boolean()),
    resultTruncated: Type.Optional(Type.Boolean()),
    text: Type.Optional(Type.String({ maxLength: 8_000 })),
    status: Type.Optional(
      Type.Union([
        Type.Literal('running'),
        Type.Literal('completed'),
        Type.Literal('error'),
      ]),
    ),
    at: Type.Optional(Type.Number()),
    run: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
  },
  { additionalProperties: false },
);
export const DelegateStatusSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    name: Type.String({ minLength: 1, maxLength: 2_000 }),
    kind: Type.Union([Type.Literal('foreground'), Type.Literal('background')]),
    state: DelegateRunStateSchema,
    createdAt: Type.Number(),
    startedAt: Type.Optional(Type.Number()),
    finishedAt: Type.Optional(Type.Number()),
    jobId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    route: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    context: Type.Optional(
      Type.Union([
        Type.Literal('branch'),
        Type.Literal('fresh'),
        Type.Literal('continuation'),
      ]),
    ),
    allowWrites: Type.Boolean(),
    activity: Type.Optional(DelegateActivitySchema),
    runCount: Type.Optional(Type.Integer({ minimum: 1 })),
    runs: Type.Optional(
      Type.Readonly(Type.Array(DelegateTimingSchema, { maxItems: 64 })),
    ),
    transcript: Type.Optional(
      Type.Readonly(
        Type.Array(DelegateTranscriptEntrySchema, { maxItems: 128 }),
      ),
    ),
    transcriptTruncated: Type.Optional(Type.Boolean()),
    result: Type.Optional(DelegateResultSchema),
    lifecycle: Type.Optional(DelegateLifecycleSchema),
  },
  { additionalProperties: false },
);

export const DelegateStatusViewModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    statuses: Type.Readonly(Type.Array(DelegateStatusSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);
export type DelegateActivity = Static<typeof DelegateActivitySchema>;
export type DelegateTranscriptEntry = Static<
  typeof DelegateTranscriptEntrySchema
>;
export type DelegateResult = Static<typeof DelegateResultSchema>;
export type DelegateStatus = Static<typeof DelegateStatusSchema>;
export type DelegateStatusViewModel = Static<
  typeof DelegateStatusViewModelSchema
>;

export const delegateStatusRenderer: RendererDescriptor = {
  id: DELEGATE_RENDERER_ID,
  mode: 'activity',
  inputSchema: DelegateStatusViewModelSchema,
  title: 'Delegate status',
  summary: 'Live status and activity for delegated subagents.',
};

export const delegateManifest: ExtensionManifest = {
  id: 'delegate',
  version: '1',
  title: 'Delegate',
  actions: [],
  renderers: [delegateStatusRenderer],
};

export const delegateCapabilitySnapshot = createRuntimeCapabilitySnapshot(
  [delegateManifest],
  [
    {
      id: DELEGATE_CAPABILITY_ID,
      version: '1',
      available: true,
      summary: 'Live delegate status and activity snapshots.',
    },
  ],
);
