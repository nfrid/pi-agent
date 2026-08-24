/**
 * Versioned, framework-independent contracts for the Pi dashboard bridge and
 * browser API.  TypeBox schemas are the source of truth; the exported
 * interfaces are Static-derived aliases so transports do not need to repeat
 * structural validation.
 */
import {
  CapabilitySummarySchema,
  ExtensionManifestSummarySchema,
  type ExtensionSurface,
  ExtensionSurfaceSchema,
  MAX_EXTENSION_SURFACES,
  parseRuntimeCapabilitySnapshot as parseExtensionCapabilitySnapshot,
  parseExtensionSurface,
  parseExtensionSurfaceList,
  RuntimeCapabilitySnapshotSchema,
  tryParseRuntimeCapabilitySnapshot as tryParseExtensionCapabilitySnapshot,
  tryParseExtensionSurface,
  tryParseExtensionSurfaceList,
} from '@pi-dashboard/extension-contributions';
import { type Static, type TSchema, Type } from 'typebox';
import {
  MAX_COMPOSER_COMMAND_ARGUMENT_HINT,
  MAX_COMPOSER_COMMAND_DESCRIPTION,
  MAX_COMPOSER_COMMAND_NAME,
  MAX_COMPOSER_COMMANDS,
  MAX_DELEGATE_HISTORY_DETAIL_ENTRIES,
  MAX_DELEGATE_HISTORY_DETAIL_TEXT,
  MAX_DELEGATE_HISTORY_GROUPS,
  MAX_DELEGATE_HISTORY_RUNS_PER_GROUP,
  MAX_DELEGATE_HISTORY_TASK,
  MAX_ID,
  MAX_PATH,
  MAX_SESSION_INDEX_DELTA_ITEMS,
  MAX_SHELL_INDEX_ITEMS,
  MAX_TEXT,
} from './limits.js';
import {
  type CheckoutSummary,
  CheckoutSummarySchema,
  type ProjectSummary,
  ProjectSummarySchema,
  type RunSummary,
  RunSummarySchema,
  type ThreadSummary,
  ThreadSummarySchema,
} from './orchestration-contracts.js';

export type {
  Checkout,
  CheckoutSummary,
  CommandReceipt,
  ModelSelection,
  Project,
  ProjectSummary,
  Run,
  RunSummary,
  SessionThreadLink,
  SessionThreadLinks,
  Thread,
  ThreadSummary,
} from './orchestration-contracts.js';
export {
  CheckoutSchema,
  CheckoutSummarySchema,
  CommandReceiptSchema,
  ModelSelectionSchema,
  ProjectSchema,
  ProjectSummarySchema,
  RunSchema,
  RunSummarySchema,
  SessionThreadLinkSchema,
  SessionThreadLinksSchema,
  ThreadSchema,
  ThreadSummarySchema,
} from './orchestration-contracts.js';

/** Version of the extension/runtime bridge protocol. Keep stable for stored and running extensions. */
export const PROTOCOL_VERSION = 1;
/** Version of the browser HTTP/tRPC dashboard protocol. */
export const DASHBOARD_PROTOCOL_VERSION = 3;
export const MAX_FRAME_BYTES = 512 * 1024;

/** Capabilities advertised by the authenticated dashboard HTTP boundary. */
export const ProtocolCapabilitiesSchema = Type.Object(
  {
    shellSnapshot: Type.Literal(true),
    sessionSnapshot: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type ProtocolCapabilities = Static<typeof ProtocolCapabilitiesSchema>;

/** Version and finite query capabilities negotiated before bootstrap. */
export const ProtocolInfoSchema = Type.Object(
  {
    protocolVersion: Type.Literal(DASHBOARD_PROTOCOL_VERSION),
    /** The daemon generation used by snapshots and live transports. */
    serverId: Type.String({ minLength: 1, maxLength: 512 }),
    capabilities: ProtocolCapabilitiesSchema,
  },
  { additionalProperties: false },
);
export type ProtocolInfo = Static<typeof ProtocolInfoSchema>;

/** Live, bounded Git metadata used by the new-thread checkout picker. */
export const GitContextSchema = Type.Object(
  {
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    dirty: Type.Boolean(),
    changedFileCount: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 100_000 }),
    ),
    localBranches: Type.Readonly(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        maxItems: 4096,
      }),
    ),
  },
  { additionalProperties: false },
);
export type GitContext = Static<typeof GitContextSchema>;

export const LiveDiagnosticsRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);
export type LiveDiagnosticsRequest = Static<
  typeof LiveDiagnosticsRequestSchema
>;

export const LiveDiagnosticsFallbacksSchema = Type.Object(
  {
    initial: Type.Integer({ minimum: 0 }),
    invalid: Type.Integer({ minimum: 0 }),
    foreign: Type.Integer({ minimum: 0 }),
    future: Type.Integer({ minimum: 0 }),
    expired: Type.Integer({ minimum: 0 }),
    unavailable: Type.Integer({ minimum: 0 }),
    'too-large': Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type LiveDiagnosticsFallbacks = Static<
  typeof LiveDiagnosticsFallbacksSchema
>;

export const LiveFeedDiagnosticsSchema = Type.Object(
  {
    generation: Type.String({ minLength: 1, maxLength: 512 }),
    feed: Type.String({ minLength: 1, maxLength: 128 }),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID })),
    active: Type.Optional(Type.Boolean()),
    sequence: Type.Integer({ minimum: 0 }),
    subscribers: Type.Integer({ minimum: 0 }),
    subscriptionOpens: Type.Integer({ minimum: 0 }),
    resumedSubscriptions: Type.Integer({ minimum: 0 }),
    replayCount: Type.Integer({ minimum: 0 }),
    replayBytes: Type.Integer({ minimum: 0 }),
    replayCountLimit: Type.Integer({ minimum: 1 }),
    replayBytesLimit: Type.Integer({ minimum: 1 }),
    queueCountLimit: Type.Integer({ minimum: 1 }),
    queueBytesLimit: Type.Integer({ minimum: 1 }),
    maxFrameBytes: Type.Integer({ minimum: 1 }),
    oldestSequence: Type.Optional(Type.Integer({ minimum: 0 })),
    newestSequence: Type.Optional(Type.Integer({ minimum: 0 })),
    oldestCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    newestCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    queuedCount: Type.Integer({ minimum: 0 }),
    queuedBytes: Type.Integer({ minimum: 0 }),
    coalesced: Type.Integer({ minimum: 0 }),
    overflowTerminations: Type.Integer({ minimum: 0 }),
    oversizedTerminations: Type.Integer({ minimum: 0 }),
    largestFrameBytes: Type.Integer({ minimum: 0 }),
    unavailableThroughSequence: Type.Optional(Type.Integer({ minimum: 0 })),
    snapshotFallbacks: LiveDiagnosticsFallbacksSchema,
  },
  { additionalProperties: false },
);
export type LiveFeedDiagnostics = Static<typeof LiveFeedDiagnosticsSchema>;

export const LiveDiagnosticsResponseSchema = Type.Object(
  {
    shell: LiveFeedDiagnosticsSchema,
    sessions: Type.Array(LiveFeedDiagnosticsSchema, {
      maxItems: MAX_SHELL_INDEX_ITEMS,
    }),
  },
  { additionalProperties: false },
);
export type LiveDiagnosticsResponse = Static<
  typeof LiveDiagnosticsResponseSchema
>;

/** Browser protocol version supplied to the shell snapshot query. */
export const ShellSnapshotRequestSchema = Type.Object(
  { protocolVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type ShellSnapshotRequest = Static<typeof ShellSnapshotRequestSchema>;
export type {
  ExtensionSurface,
  ExtensionSurfaceList,
  ExtensionSurfacePlacement,
} from '@pi-dashboard/extension-contributions';
/** Capability contracts and replay bounds are optional protocol-v1 extensions. */
export {
  ExtensionSurfaceListSchema,
  ExtensionSurfacePlacementSchema,
  ExtensionSurfaceSchema,
  MAX_NON_IDEMPOTENT_ACTION_IDS,
  parseExtensionSurface,
  parseExtensionSurfaceList,
  RuntimeCapabilitySnapshotSchema,
  safeRuntimeCapabilitySnapshot,
  tryParseExtensionSurface,
  tryParseExtensionSurfaceList,
} from '@pi-dashboard/extension-contributions';
export const parseRuntimeCapabilitySnapshot = parseExtensionCapabilitySnapshot;
export const tryParseRuntimeCapabilitySnapshot =
  tryParseExtensionCapabilitySnapshot;
export type {
  ActionInvocation,
  ExtensionManifestSummary,
  RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
export {
  ActionInvocationSchema,
  parseActionInvocation,
  tryParseActionInvocation,
} from '@pi-dashboard/extension-contributions';

/** Maximum number of dashboard-owned drafts retained for one session. */
export const MAX_QUEUE_DRAFTS = 32;
/** Maximum UTF-16 code units in one dashboard-owned draft. */
export const MAX_QUEUE_DRAFT_TEXT = 20_000;
/** Aggregate draft text budget keeps runtime state updates below frame limits. */
export const MAX_QUEUE_DRAFT_TOTAL_TEXT = 200_000;
/** Compatibility spelling for clients that call these entries queued messages. */
export const MAX_QUEUE_MESSAGES = MAX_QUEUE_DRAFTS;
export const MAX_QUEUE_MESSAGE_TEXT = MAX_QUEUE_DRAFT_TEXT;

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: MAX_ID,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$',
});
const FiniteNumberSchema = Type.Number();
const UnknownSchema = Type.Unknown();

export const RuntimeLiveStateSchema = Type.Union([
  Type.Literal('idle'),
  Type.Literal('working'),
  Type.Literal('compacting'),
  Type.Literal('waiting'),
  Type.Literal('aborting'),
  Type.Literal('stopping'),
  Type.Literal('failed'),
]);
export type RuntimeLiveState = Static<typeof RuntimeLiveStateSchema>;

export const RuntimeOwnershipSchema = Type.Union([
  Type.Literal('external'),
  Type.Literal('managed'),
]);
export type RuntimeOwnership = Static<typeof RuntimeOwnershipSchema>;

export const RuntimeModelOptionSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 200 }),
    model: Type.String({ minLength: 1, maxLength: 300 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    supportsImages: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type RuntimeModelOption = Static<typeof RuntimeModelOptionSchema>;

export const ComposerCommandSourceSchema = Type.Union([
  Type.Literal('builtin'),
  Type.Literal('prompt'),
  Type.Literal('skill'),
]);
export type ComposerCommandSource = Static<typeof ComposerCommandSourceSchema>;

export const ComposerCommandEntrySchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: MAX_COMPOSER_COMMAND_NAME,
      pattern: '^[^\\s/]+$',
    }),
    description: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_COMPOSER_COMMAND_DESCRIPTION,
      }),
    ),
    argumentHint: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_COMPOSER_COMMAND_ARGUMENT_HINT,
      }),
    ),
    source: ComposerCommandSourceSchema,
  },
  { additionalProperties: false },
);
export type ComposerCommandEntry = Static<typeof ComposerCommandEntrySchema>;

/** Builtins whose dashboard submission adapter is intentionally supported. */
export const DASHBOARD_SUPPORTED_BUILTIN_COMMANDS = [
  {
    name: 'compact',
    description: 'Compact the current session while preserving recent context.',
    argumentHint: '[instructions]',
    source: 'builtin',
  },
  {
    name: 'name',
    description: 'Set the current session name.',
    argumentHint: '<name>',
    source: 'builtin',
  },
  {
    name: 'model',
    description: 'Switch to an available provider/model.',
    argumentHint: '<provider/model>',
    source: 'builtin',
  },
  {
    name: 'quit',
    description: 'Exit the current Pi session.',
    source: 'builtin',
  },
] as const satisfies readonly ComposerCommandEntry[];
/** Compatibility shorthand for consumers that call these builtins. */
export const DASHBOARD_SUPPORTED_BUILTINS =
  DASHBOARD_SUPPORTED_BUILTIN_COMMANDS;

export const ComposerCommandCatalogueSchema = Type.Object(
  {
    commands: Type.Readonly(
      Type.Array(ComposerCommandEntrySchema, {
        maxItems: MAX_COMPOSER_COMMANDS,
      }),
    ),
  },
  { additionalProperties: false },
);
export type ComposerCommandCatalogue = Static<
  typeof ComposerCommandCatalogueSchema
>;
/** Runtime composer-command catalogue response. */
export const ComposerCommandsResponseSchema = ComposerCommandCatalogueSchema;
export type ComposerCommandsResponse = ComposerCommandCatalogue;

/** Compatibility aliases for the original dashboard protocol surface names. */
export const RuntimeExtensionSurfaceSchema = ExtensionSurfaceSchema;
export type RuntimeExtensionSurface = ExtensionSurface;
export const LiveExtensionSurfaceSchema = RuntimeExtensionSurfaceSchema;
export type LiveExtensionSurface = RuntimeExtensionSurface;
export const MAX_RUNTIME_EXTENSION_SURFACES = MAX_EXTENSION_SURFACES;
export const parseRuntimeExtensionSurface = parseExtensionSurface;
export const tryParseRuntimeExtensionSurface = tryParseExtensionSurface;
export const parseRuntimeExtensionSurfaceList = parseExtensionSurfaceList;
export const tryParseRuntimeExtensionSurfaceList = tryParseExtensionSurfaceList;

const SessionSnapshotProperties = {
  id: IdentifierSchema,
  file: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PATH })),
  /** Explicit Pi session_info name, when one exists. */
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  /** Deterministic fallback derived from the first user message. */
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PATH })),
  leafId: Type.Optional(IdentifierSchema),
  /** True only when entries is a bounded, successful serialization of the active branch. */
  entriesComplete: Type.Optional(Type.Boolean()),
  entries: Type.Readonly(Type.Array(UnknownSchema)),
};
export const SessionSnapshotSchema = Type.Object(SessionSnapshotProperties, {
  additionalProperties: false,
});
type SessionSnapshotStatic = Static<typeof SessionSnapshotSchema>;
export type SessionSnapshot = Omit<SessionSnapshotStatic, 'entries'> & {
  readonly entries: readonly unknown[];
  readonly entriesComplete?: boolean;
};
export const SessionSnapshotFullSchema = SessionSnapshotSchema;
export type SessionSnapshotFull = SessionSnapshot;
export const SessionSnapshotPatchSchema = Type.Object(
  {
    id: Type.Optional(IdentifierSchema),
    file: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PATH })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PATH })),
    leafId: Type.Optional(IdentifierSchema),
    entriesComplete: Type.Optional(Type.Boolean()),
    entries: Type.Optional(Type.Readonly(Type.Array(UnknownSchema))),
  },
  { additionalProperties: false },
);
export type SessionSnapshotPatch = Static<typeof SessionSnapshotPatchSchema>;

export const BridgeImageAttachmentSchema = Type.Object(
  {
    type: Type.Literal('image'),
    /** Server-owned temporary file; browser clients can never provide this path. */
    path: Type.String({ minLength: 1, maxLength: MAX_PATH }),
    mediaType: Type.Union([
      Type.Literal('image/png'),
      Type.Literal('image/jpeg'),
      Type.Literal('image/webp'),
    ]),
  },
  { additionalProperties: false },
);
export type BridgeImageAttachment = Static<typeof BridgeImageAttachmentSchema>;

export const QueueDraftModeSchema = Type.Union([
  Type.Literal('steer'),
  Type.Literal('followUp'),
]);
export type QueueDraftMode = Static<typeof QueueDraftModeSchema>;
export const QueueDraftSchema = Type.Object(
  {
    /** Stable browser-owned identity, distinct from a command frame id. */
    clientId: IdentifierSchema,
    mode: QueueDraftModeSchema,
    text: Type.String({ minLength: 1, maxLength: MAX_QUEUE_DRAFT_TEXT }),
  },
  { additionalProperties: false },
);
export type QueueDraft = Static<typeof QueueDraftSchema>;

const RuntimeSnapshotProperties = {
  runtimeId: IdentifierSchema,
  ownership: RuntimeOwnershipSchema,
  pid: Type.Integer({ minimum: 1 }),
  cwd: Type.String({ minLength: 1, maxLength: MAX_PATH }),
  /** Server-owned durable orchestration association. Runtime clients may send
   * spoofed values, but the dashboard replaces them before publication. */
  projectId: Type.Optional(Type.Union([IdentifierSchema, Type.Null()])),
  checkoutId: Type.Optional(Type.Union([IdentifierSchema, Type.Null()])),
  liveState: RuntimeLiveStateSchema,
  session: SessionSnapshotSchema,
  model: Type.Optional(
    Type.Object(
      {
        provider: Type.String({ minLength: 1, maxLength: 200 }),
        model: Type.String({ minLength: 1, maxLength: 300 }),
        thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        supportsImages: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  ),
  /** Bounded catalogue from the installed Pi model registry; credentials never cross the bridge. */
  modelCatalog: Type.Optional(
    Type.Readonly(Type.Array(RuntimeModelOptionSchema, { maxItems: 256 })),
  ),
  /** Commands accepted by the dashboard composer, excluding extension commands. */
  composerCommands: Type.Optional(
    Type.Readonly(
      Type.Array(ComposerCommandEntrySchema, {
        maxItems: MAX_COMPOSER_COMMANDS,
      }),
    ),
  ),
  /** Values accepted by the installed runtime's setThinkingLevel API. */
  thinkingLevels: Type.Optional(
    Type.Readonly(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
        maxItems: 16,
      }),
    ),
  ),
  contextUsage: Type.Optional(
    Type.Object(
      {
        tokens: Type.Union([Type.Number(), Type.Null()]),
        contextWindow: Type.Number(),
        percent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      },
      { additionalProperties: false },
    ),
  ),
  /** Dashboard-owned text drafts, before they are handed to Pi's queue. */
  queueDrafts: Type.Optional(
    Type.Readonly(Type.Array(QueueDraftSchema, { maxItems: MAX_QUEUE_DRAFTS })),
  ),
  lastError: Type.Optional(Type.String({ minLength: 1, maxLength: 10_000 })),
  online: Type.Optional(Type.Boolean()),
  lastSeenAt: Type.Optional(FiniteNumberSchema),
  /** Optional validated extension capabilities advertised by newer runtimes. */
  capabilities: Type.Optional(RuntimeCapabilitySnapshotSchema),
  /** Bounded live state projected by installed framework-free extensions. */
  extensionSurfaces: Type.Optional(
    Type.Readonly(
      Type.Array(RuntimeExtensionSurfaceSchema, {
        maxItems: MAX_RUNTIME_EXTENSION_SURFACES,
      }),
    ),
  ),
};

export const RuntimeSnapshotSchema = Type.Object(RuntimeSnapshotProperties, {
  additionalProperties: false,
});
type RuntimeSnapshotStatic = Static<typeof RuntimeSnapshotSchema>;
export type RuntimeSnapshot = Omit<
  RuntimeSnapshotStatic,
  'session' | 'queueDrafts' | 'extensionSurfaces' | 'composerCommands'
> & {
  session: SessionSnapshot;
  readonly queueDrafts?: readonly QueueDraft[];
  readonly extensionSurfaces?: readonly RuntimeExtensionSurface[];
  readonly composerCommands?: readonly ComposerCommandEntry[];
};

// Type.Partial needs its options argument to preserve strict unknown-field
// rejection in TypeBox 1.x.
export const RuntimeSnapshotPatchSchema = Type.Partial(RuntimeSnapshotSchema, {
  additionalProperties: false,
});
type RuntimeSnapshotPatchStatic = Static<typeof RuntimeSnapshotPatchSchema>;
export type RuntimeSnapshotPatch = Omit<
  RuntimeSnapshotPatchStatic,
  'session' | 'queueDrafts' | 'extensionSurfaces' | 'composerCommands'
> & {
  session?: SessionSnapshot;
  queueDrafts?: readonly QueueDraft[];
  extensionSurfaces?: readonly RuntimeExtensionSurface[];
  composerCommands?: readonly ComposerCommandEntry[];
};
/** Compatibility spelling used by some consumers. */
export const RuntimeSnapshotFullSchema = RuntimeSnapshotSchema;
export type RuntimeSnapshotFull = RuntimeSnapshot;

/**
 * Normalized live payloads.  The remote-control adapter is responsible for
 * producing these explicit identities.  `data` is an opaque provider payload,
 * deliberately kept behind one named field rather than searched recursively.
 */
export const NormalizedMessagePayloadSchema = Type.Object(
  {
    messageId: IdentifierSchema,
    role: Type.String({ minLength: 1, maxLength: 64 }),
    content: UnknownSchema,
    timestamp: Type.Optional(
      Type.Union([Type.String({ maxLength: 128 }), Type.Number()]),
    ),
    turnId: Type.Optional(IdentifierSchema),
    toolCallIds: Type.Optional(Type.Array(IdentifierSchema, { maxItems: 128 })),
    phase: Type.Optional(
      Type.Union([
        Type.Literal('started'),
        Type.Literal('updated'),
        Type.Literal('finished'),
      ]),
    ),
    sessionId: Type.Optional(IdentifierSchema),
    data: Type.Optional(UnknownSchema),
  },
  { additionalProperties: false },
);
export type NormalizedMessagePayload = Static<
  typeof NormalizedMessagePayloadSchema
>;
export const NormalizedMessageLivePayloadSchema =
  NormalizedMessagePayloadSchema;
export type NormalizedMessageLivePayload = NormalizedMessagePayload;
export const MessageLivePayloadSchema = NormalizedMessagePayloadSchema;
export type MessageLivePayload = NormalizedMessagePayload;

export const NormalizedToolPayloadSchema = Type.Object(
  {
    toolCallId: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 512 }),
    arguments: Type.Optional(UnknownSchema),
    result: Type.Optional(UnknownSchema),
    isError: Type.Optional(Type.Boolean()),
    /** Chronology inherited from the owning assistant message when needed. */
    timestamp: Type.Optional(
      Type.Union([Type.String({ maxLength: 128 }), Type.Number()]),
    ),
    status: Type.Optional(
      Type.Union([
        Type.Literal('pending'),
        Type.Literal('running'),
        Type.Literal('complete'),
        Type.Literal('completed'),
        Type.Literal('finished'),
        Type.Literal('success'),
        Type.Literal('error'),
        Type.Literal('failed'),
      ]),
    ),
    turnId: Type.Optional(IdentifierSchema),
    sessionId: Type.Optional(IdentifierSchema),
    phase: Type.Optional(
      Type.Union([
        Type.Literal('started'),
        Type.Literal('updated'),
        Type.Literal('finished'),
      ]),
    ),
    data: Type.Optional(UnknownSchema),
  },
  { additionalProperties: false },
);
export type NormalizedToolPayload = Static<typeof NormalizedToolPayloadSchema>;
export const NormalizedToolLivePayloadSchema = NormalizedToolPayloadSchema;
export type NormalizedToolLivePayload = NormalizedToolPayload;
export const ToolLivePayloadSchema = NormalizedToolPayloadSchema;
export type ToolLivePayload = NormalizedToolPayload;

export const RuntimeHelloCapabilitiesSchema = Type.Object(
  {
    heartbeat: Type.Optional(Type.Literal(true)),
    /** New runtimes advertise extension capabilities in this field. */
    extensions: Type.Optional(RuntimeCapabilitySnapshotSchema),
    /** Direct fields are accepted for simple protocol-v1 adapters. */
    version: Type.Optional(Type.Literal(1)),
    extensionCapabilities: Type.Optional(RuntimeCapabilitySnapshotSchema),
    capabilitySummaries: Type.Optional(
      Type.Array(CapabilitySummarySchema, { maxItems: 256 }),
    ),
    manifests: Type.Optional(
      Type.Array(ExtensionManifestSummarySchema, { maxItems: 128 }),
    ),
  },
  { additionalProperties: false },
);
export type RuntimeHelloCapabilities = Static<
  typeof RuntimeHelloCapabilitiesSchema
>;

const DelegateTranscriptPayloadScalarSchema = Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number(),
  Type.String({ maxLength: 1_024 }),
]);

function delegateTranscriptPayloadSchema(depth: number): TSchema {
  if (depth <= 0) return DelegateTranscriptPayloadScalarSchema;
  const child = delegateTranscriptPayloadSchema(depth - 1);
  return Type.Union([
    DelegateTranscriptPayloadScalarSchema,
    Type.Array(child, { maxItems: 16 }),
    Type.Record(Type.String({ maxLength: 128 }), child, { maxProperties: 16 }),
  ]);
}

/** Live delegate IDs may include a longer extension-generated lineage path. */
export const DelegateTranscriptEntryIdSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$',
});
/** Bounded public activity entry shared by live delegate transport and history. */
export const DelegateTranscriptEntrySchema = Type.Object(
  {
    id: DelegateTranscriptEntryIdSchema,
    type: Type.Union([
      Type.Literal('task'),
      Type.Literal('thinking'),
      Type.Literal('tool'),
      Type.Literal('assistant'),
      Type.Literal('error'),
    ]),
    label: Type.String({ minLength: 1, maxLength: 2_000 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    arguments: Type.Optional(delegateTranscriptPayloadSchema(4)),
    result: Type.Optional(delegateTranscriptPayloadSchema(4)),
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
    at: Type.Optional(FiniteNumberSchema),
    run: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
  },
  { additionalProperties: false },
);
export type DelegateTranscriptEntry = Static<
  typeof DelegateTranscriptEntrySchema
>;

const DelegateLiveRunStateSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('success'),
  Type.Literal('error'),
  Type.Literal('aborted'),
  Type.Literal('timed-out'),
]);

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

const DelegateLiveRunSchema = Type.Object(
  {
    runId: IdentifierSchema,
    /** Missing only for legacy delegate records. */
    sessionId: Type.Optional(IdentifierSchema),
    lineageId: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 2_000 }),
    kind: Type.Union([Type.Literal('foreground'), Type.Literal('background')]),
    state: DelegateLiveRunStateSchema,
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
    pauseState: Type.Optional(
      Type.Union([Type.Literal('pausing'), Type.Literal('paused')]),
    ),
    pausedAt: Type.Optional(Type.Number()),
    transcript: Type.Readonly(
      Type.Array(DelegateTranscriptEntrySchema, { maxItems: 128 }),
    ),
    transcriptTruncated: Type.Optional(Type.Boolean()),
    /** Compact logical workflow metadata; never contains payloads or reports. */
    workflow: Type.Optional(DelegateWorkflowMetadataSchema),
  },
  { additionalProperties: false },
);
export type DelegateLiveRun = Static<typeof DelegateLiveRunSchema>;

export const ActiveDelegateTranscriptBaselineSchema = Type.Object(
  {
    version: Type.Literal(1),
    serverId: IdentifierSchema,
    cursor: Type.Integer({ minimum: 0 }),
    sessionId: IdentifierSchema,
    runtimeId: Type.Optional(IdentifierSchema),
    runtimeEpoch: Type.Optional(IdentifierSchema),
    runtimeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    runs: Type.Readonly(Type.Array(DelegateLiveRunSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);
export type ActiveDelegateTranscriptBaseline = Static<
  typeof ActiveDelegateTranscriptBaselineSchema
>;

export const DelegateTranscriptUpdatedEventSchema = Type.Object(
  {
    type: Type.Literal('delegate.transcript.updated'),
    sessionId: IdentifierSchema,
    lineageId: IdentifierSchema,
    runId: IdentifierSchema,
    entry: DelegateTranscriptEntrySchema,
  },
  { additionalProperties: false },
);
export type DelegateTranscriptUpdatedEvent = Static<
  typeof DelegateTranscriptUpdatedEventSchema
>;

const RuntimeHelloEventSchema = Type.Object(
  {
    type: Type.Literal('runtime.hello'),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    token: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    identityToken: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    capabilities: Type.Optional(RuntimeHelloCapabilitiesSchema),
    snapshot: RuntimeSnapshotSchema,
  },
  { additionalProperties: false },
);
const RuntimeStateEventSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('runtime.heartbeat'),
      Type.Literal('runtime.stateChanged'),
    ]),
    state: RuntimeLiveStateSchema,
    snapshot: Type.Optional(RuntimeSnapshotPatchSchema),
  },
  { additionalProperties: false },
);
const SessionEventSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('session.changed'),
      Type.Literal('session.snapshot'),
    ]),
    session: SessionSnapshotSchema,
  },
  { additionalProperties: false },
);
const SessionCompactedEventSchema = Type.Object(
  {
    type: Type.Literal('session.compacted'),
    sessionId: IdentifierSchema,
    entry: UnknownSchema,
    entryId: Type.Optional(IdentifierSchema),
  },
  { additionalProperties: false },
);
export const SessionTranscriptResetReasonSchema = Type.Union([
  Type.Literal('source-rewrite'),
  Type.Literal('source-truncated'),
  Type.Literal('source-overflow'),
  Type.Literal('entry-too-large'),
]);
export type SessionTranscriptResetReason = Static<
  typeof SessionTranscriptResetReasonSchema
>;
const SessionTranscriptResetEventSchema = Type.Object(
  {
    type: Type.Literal('session.transcript.reset'),
    sessionId: IdentifierSchema,
    reason: SessionTranscriptResetReasonSchema,
  },
  { additionalProperties: false },
);
export type SessionTranscriptResetEvent = Static<
  typeof SessionTranscriptResetEventSchema
>;
const MessageEventSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('message.started'),
      Type.Literal('message.updated'),
      Type.Literal('message.finished'),
    ]),
    sessionId: IdentifierSchema,
    // Unknown is intentional for v1 compatibility. Normalized payloads use
    // NormalizedMessagePayloadSchema at the adapter/domain boundary.
    message: UnknownSchema,
  },
  { additionalProperties: false },
);
const ToolEventSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('tool.started'),
      Type.Literal('tool.updated'),
      Type.Literal('tool.finished'),
    ]),
    sessionId: IdentifierSchema,
    tool: UnknownSchema,
  },
  { additionalProperties: false },
);
const AgentSettledEventSchema = Type.Object(
  { type: Type.Literal('agent.settled'), sessionId: IdentifierSchema },
  { additionalProperties: false },
);
const GoodbyeEventSchema = Type.Object(
  {
    type: Type.Literal('runtime.goodbye'),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const NormalizedMessageLiveEventSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('message.started'),
      Type.Literal('message.updated'),
      Type.Literal('message.finished'),
    ]),
    sessionId: IdentifierSchema,
    message: NormalizedMessagePayloadSchema,
  },
  { additionalProperties: false },
);
export type NormalizedMessageLiveEvent = Static<
  typeof NormalizedMessageLiveEventSchema
>;
export const NormalizedToolLiveEventSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('tool.started'),
      Type.Literal('tool.updated'),
      Type.Literal('tool.finished'),
    ]),
    sessionId: IdentifierSchema,
    tool: NormalizedToolPayloadSchema,
  },
  { additionalProperties: false },
);
export type NormalizedToolLiveEvent = Static<
  typeof NormalizedToolLiveEventSchema
>;

export const BridgeEventSchema = Type.Union([
  RuntimeHelloEventSchema,
  RuntimeStateEventSchema,
  SessionEventSchema,
  SessionCompactedEventSchema,
  SessionTranscriptResetEventSchema,
  MessageEventSchema,
  ToolEventSchema,
  DelegateTranscriptUpdatedEventSchema,
  AgentSettledEventSchema,
  GoodbyeEventSchema,
]);
type BridgeEventStatic = Static<typeof BridgeEventSchema>;
export type BridgeEvent =
  | (Omit<
      Static<typeof RuntimeHelloEventSchema>,
      'protocolVersion' | 'snapshot'
    > & {
      protocolVersion: number;
      snapshot: RuntimeSnapshot;
    })
  | (Omit<Static<typeof RuntimeStateEventSchema>, 'snapshot'> & {
      snapshot?: RuntimeSnapshotPatch;
    })
  | (Omit<Static<typeof SessionEventSchema>, 'session'> & {
      session: SessionSnapshot;
    })
  | Static<typeof SessionCompactedEventSchema>
  | Static<typeof SessionTranscriptResetEventSchema>
  | Static<typeof MessageEventSchema>
  | Static<typeof ToolEventSchema>
  | Static<typeof DelegateTranscriptUpdatedEventSchema>
  | Static<typeof AgentSettledEventSchema>
  | Static<typeof GoodbyeEventSchema>;
/** Exact schema-derived union retained for schema consumers. */
export type BridgeEventSchemaValue = BridgeEventStatic;

const BridgeCommandBaseProperties = {
  id: Type.String({ minLength: 1, maxLength: 128 }),
};
const PromptCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Union([
      Type.Literal('prompt'),
      Type.Literal('steer'),
      Type.Literal('followUp'),
    ]),
    text: Type.String({ maxLength: MAX_TEXT }),
    images: Type.Optional(
      Type.Array(BridgeImageAttachmentSchema, { maxItems: 4 }),
    ),
  },
  { additionalProperties: false },
);
export const QueueDraftAddCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    /** `queueDraft.*` is accepted as a spelling for older dashboard clients. */
    type: Type.Union([
      Type.Literal('queue.add'),
      Type.Literal('queueDraft.add'),
    ]),
    clientId: IdentifierSchema,
    mode: QueueDraftModeSchema,
    text: Type.String({ maxLength: MAX_QUEUE_DRAFT_TEXT }),
  },
  { additionalProperties: false },
);
export const QueueDraftUpdateCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Union([
      Type.Literal('queue.update'),
      Type.Literal('queueDraft.update'),
    ]),
    clientId: IdentifierSchema,
    mode: QueueDraftModeSchema,
    text: Type.String({ maxLength: MAX_QUEUE_DRAFT_TEXT }),
  },
  { additionalProperties: false },
);
export const QueueDraftRemoveCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Union([
      Type.Literal('queue.remove'),
      Type.Literal('queueDraft.remove'),
    ]),
    clientId: IdentifierSchema,
  },
  { additionalProperties: false },
);
export type QueueDraftAddCommand = Static<typeof QueueDraftAddCommandSchema>;
export type QueueDraftUpdateCommand = Static<
  typeof QueueDraftUpdateCommandSchema
>;
export type QueueDraftRemoveCommand = Static<
  typeof QueueDraftRemoveCommandSchema
>;
export const QueueDraftCommandSchema = Type.Union([
  QueueDraftAddCommandSchema,
  QueueDraftUpdateCommandSchema,
  QueueDraftRemoveCommandSchema,
]);
export type QueueDraftCommand = Static<typeof QueueDraftCommandSchema>;
const SimpleCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Union([
      Type.Literal('abort'),
      Type.Literal('compact.cancel'),
      Type.Literal('shutdown'),
    ]),
  },
  { additionalProperties: false },
);
const SetModelCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Literal('setModel'),
    provider: Type.String({ minLength: 1, maxLength: 200 }),
    model: Type.String({ minLength: 1, maxLength: 300 }),
  },
  { additionalProperties: false },
);
const SetThinkingCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Literal('setThinking'),
    level: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
const SetSessionNameCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Literal('setSessionName'),
    name: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);
/** Semantic contribution invocation. It is intentionally not a slash command. */
export const SemanticActionCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Literal('action.invoke'),
    actionId: IdentifierSchema,
    input: UnknownSchema,
  },
  { additionalProperties: false },
);
export type SemanticActionCommand = Static<typeof SemanticActionCommandSchema>;
export const ActionCommandEnvelopeSchema = SemanticActionCommandSchema;
export type ActionCommandEnvelope = SemanticActionCommand;
export const BridgeCommandSchema = Type.Union([
  PromptCommandSchema,
  QueueDraftCommandSchema,
  SimpleCommandSchema,
  SetModelCommandSchema,
  SetThinkingCommandSchema,
  SetSessionNameCommandSchema,
  SemanticActionCommandSchema,
]);
export type BridgeCommand = Static<typeof BridgeCommandSchema>;
export type BridgeCommandBase = { id: string };

/** Caller-owned IDs for durable browser lifecycle mutations. */
export const LifecycleCommandIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$',
});
export type LifecycleCommandId = Static<typeof LifecycleCommandIdSchema>;

/** One bounded, idempotent browser command sent to a live runtime. */
export const RuntimeCommandInputSchema = Type.Object(
  {
    runtimeId: IdentifierSchema,
    command: BridgeCommandSchema,
  },
  { additionalProperties: false },
);
export type RuntimeCommandInput = Static<typeof RuntimeCommandInputSchema>;
export const RuntimeCommandRequestSchema = RuntimeCommandInputSchema;
export type RuntimeCommandRequest = RuntimeCommandInput;

export const RuntimeCommandStatusSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('already-completed'),
]);
export type RuntimeCommandStatus = Static<typeof RuntimeCommandStatusSchema>;
export const RuntimeCommandOutputSchema = Type.Object(
  {
    runtimeId: IdentifierSchema,
    commandId: Type.String({ minLength: 1, maxLength: 128 }),
    status: RuntimeCommandStatusSchema,
    result: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type RuntimeCommandOutput = Static<typeof RuntimeCommandOutputSchema>;
export const RuntimeCommandReceiptSchema = RuntimeCommandOutputSchema;
export type RuntimeCommandReceipt = RuntimeCommandOutput;
export const RuntimeCommandResponseSchema = RuntimeCommandOutputSchema;
export type RuntimeCommandResponse = RuntimeCommandOutput;

const EventFrameSchema = Type.Object(
  {
    kind: Type.Literal('event'),
    event: BridgeEventSchema,
    seq: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const CommandFrameSchema = Type.Object(
  { kind: Type.Literal('command'), command: BridgeCommandSchema },
  { additionalProperties: false },
);
const AckFrameSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('ack'),
      id: Type.String({ minLength: 1, maxLength: 128 }),
      ok: Type.Literal(true),
      result: Type.Optional(UnknownSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ack'),
      id: Type.String({ minLength: 1, maxLength: 128 }),
      ok: Type.Literal(false),
      error: Type.String({ minLength: 1, maxLength: 1000 }),
      /** Machine-readable semantic action/availability error when supplied. */
      code: Type.Optional(IdentifierSchema),
    },
    { additionalProperties: false },
  ),
]);
export const BridgeFrameSchema = Type.Union([
  EventFrameSchema,
  CommandFrameSchema,
  AckFrameSchema,
]);
type BridgeFrameStatic = Static<typeof BridgeFrameSchema>;
export type BridgeFrame =
  | { kind: 'event'; event: BridgeEvent; seq: number }
  | Extract<BridgeFrameStatic, { kind: 'command' }>
  | Extract<BridgeFrameStatic, { kind: 'ack' }>;

export const SessionIndexEntrySchema = Type.Object(
  {
    id: IdentifierSchema,
    file: Type.String({ maxLength: MAX_PATH }),
    cwd: Type.String({ maxLength: MAX_PATH }),
    /** Auxiliary delegate identity; omitted for ordinary sessions and legacy files. */
    sessionKind: Type.Optional(Type.Literal('delegate')),
    /** Immutable original parent session for nested delegates. */
    parentSessionId: Type.Optional(IdentifierSchema),
    /** Server-resolved durable project association; null means unassigned. */
    projectId: Type.Optional(Type.Union([IdentifierSchema, Type.Null()])),
    checkoutId: Type.Optional(Type.Union([IdentifierSchema, Type.Null()])),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    /** Compact resume hints derived from the latest indexed leaf ancestry. */
    lastKnownModel: Type.Optional(
      Type.Object(
        {
          provider: Type.String({ minLength: 1, maxLength: 200 }),
          model: Type.String({ minLength: 1, maxLength: 300 }),
        },
        { additionalProperties: false },
      ),
    ),
    lastKnownThinking: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64 }),
    ),
    lastKnownContextTokens: Type.Optional(Type.Number({ minimum: 0 })),
    /** Session header timestamp, used for stable chronological ordering. */
    startedAt: Type.Optional(FiniteNumberSchema),
    updatedAt: FiniteNumberSchema,
    activeRuntimeId: Type.Optional(IdentifierSchema),
    entryCount: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type SessionIndexEntry = Static<typeof SessionIndexEntrySchema>;

export const NotificationEventSchema = Type.Object(
  {
    id: IdentifierSchema,
    kind: Type.Union([
      Type.Literal('waiting'),
      Type.Literal('failed'),
      Type.Literal('runtime-exited'),
      Type.Literal('settled'),
    ]),
    runtimeId: Type.Optional(IdentifierSchema),
    sessionId: Type.Optional(IdentifierSchema),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    body: Type.String({ maxLength: MAX_TEXT }),
    createdAt: FiniteNumberSchema,
    readAt: Type.Optional(FiniteNumberSchema),
  },
  { additionalProperties: false },
);
export type NotificationEvent = Static<typeof NotificationEventSchema>;

export const ShellProjectionDomainSchema = Type.Union([
  Type.Literal('projects'),
  Type.Literal('checkouts'),
  Type.Literal('threads'),
  Type.Literal('runs'),
  Type.Literal('unread'),
]);
export type ShellProjectionDomain = Static<typeof ShellProjectionDomainSchema>;
/** Describes catalogue entities omitted to fit the aggregate shell budget. */
export const ShellProjectionSchema = Type.Object(
  {
    truncated: Type.Boolean(),
    omitted: Type.Readonly(
      Type.Array(ShellProjectionDomainSchema, { maxItems: 6 }),
    ),
  },
  { additionalProperties: false },
);
export type ShellProjection = Static<typeof ShellProjectionSchema>;

export const BrowserSnapshotSchema = Type.Object(
  {
    /** Changes whenever the dashboard daemon process restarts. */
    serverId: Type.String({ minLength: 1, maxLength: 512 }),
    /** Compatibility revision retained for v1 websocket clients. */
    revision: Type.Integer({ minimum: 0 }),
    /** Authoritative position in the daemon-global resumable event stream. */
    cursor: Type.Integer({ minimum: 0 }),
    runtimes: Type.Array(RuntimeSnapshotSchema),
    sessions: Type.Array(SessionIndexEntrySchema),
    /** Durable orchestration shell summaries; transcript entries never cross this boundary. */
    projects: Type.Optional(
      Type.Array(ProjectSummarySchema, { maxItems: 4096 }),
    ),
    checkouts: Type.Optional(
      Type.Array(CheckoutSummarySchema, { maxItems: 4096 }),
    ),
    threads: Type.Optional(Type.Array(ThreadSummarySchema, { maxItems: 4096 })),
    runs: Type.Optional(Type.Array(RunSummarySchema, { maxItems: 4096 })),
    usage: Type.Optional(UnknownSchema),
    unread: Type.Array(NotificationEventSchema),
    /** Present on shell projections; omitted on full compatibility snapshots. */
    shellProjection: Type.Optional(ShellProjectionSchema),
  },
  { additionalProperties: false },
);
type BrowserSnapshotStatic = Static<typeof BrowserSnapshotSchema>;
export type BrowserSnapshot = Omit<
  BrowserSnapshotStatic,
  | 'runtimes'
  | 'sessions'
  | 'unread'
  | 'projects'
  | 'checkouts'
  | 'threads'
  | 'runs'
> & {
  readonly runtimes: readonly RuntimeSnapshot[];
  readonly sessions: readonly SessionIndexEntry[];
  readonly projects?: readonly ProjectSummary[];
  readonly checkouts?: readonly CheckoutSummary[];
  readonly threads?: readonly ThreadSummary[];
  readonly runs?: readonly RunSummary[];
  readonly unread: readonly NotificationEvent[];
};

/**
 * The tRPC shell contract is deliberately narrower than the compatibility
 * browser snapshot: every runtime session is compacted and cannot carry a
 * transcript entry. The old BrowserSnapshot schema remains unchanged for the
 * websocket/SSE and bootstrap rollout path.
 */
export const ShellRuntimeSnapshotSchema = Type.Object(
  {
    ...RuntimeSnapshotProperties,
    session: Type.Object(
      {
        ...SessionSnapshotProperties,
        entries: Type.Readonly(Type.Array(UnknownSchema, { maxItems: 0 })),
      },
      { additionalProperties: false },
    ),
    extensionSurfaces: Type.Optional(
      Type.Readonly(
        Type.Array(RuntimeExtensionSurfaceSchema, { maxItems: 32 }),
      ),
    ),
    shellStateTruncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ShellRuntimeSnapshot = Static<typeof ShellRuntimeSnapshotSchema>;

/** Bounded JSON-like usage data allowed on shell feed patches. */
const ShellUsageScalarSchema = Type.Union([
  Type.String({ maxLength: MAX_TEXT }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
const ShellUsageDepth0Schema = ShellUsageScalarSchema;
const ShellUsageDepth1Schema = Type.Union([
  ShellUsageScalarSchema,
  Type.Readonly(Type.Array(ShellUsageDepth0Schema, { maxItems: 128 })),
  Type.Record(Type.String({ maxLength: 128 }), ShellUsageDepth0Schema, {
    maxProperties: 128,
  }),
]);
const ShellUsageDepth2Schema = Type.Union([
  ShellUsageScalarSchema,
  Type.Readonly(Type.Array(ShellUsageDepth1Schema, { maxItems: 128 })),
  Type.Record(Type.String({ maxLength: 128 }), ShellUsageDepth1Schema, {
    maxProperties: 128,
  }),
]);
const ShellUsageDepth3Schema = Type.Union([
  ShellUsageScalarSchema,
  Type.Readonly(Type.Array(ShellUsageDepth2Schema, { maxItems: 128 })),
  Type.Record(Type.String({ maxLength: 128 }), ShellUsageDepth2Schema, {
    maxProperties: 128,
  }),
]);
const ShellUsageDepth4Schema = Type.Union([
  ShellUsageScalarSchema,
  Type.Readonly(Type.Array(ShellUsageDepth3Schema, { maxItems: 128 })),
  Type.Record(Type.String({ maxLength: 128 }), ShellUsageDepth3Schema, {
    maxProperties: 128,
  }),
]);
export const ShellUsageSchema = Type.Union([
  ShellUsageScalarSchema,
  Type.Readonly(Type.Array(ShellUsageDepth4Schema, { maxItems: 128 })),
  Type.Record(Type.String({ maxLength: 128 }), ShellUsageDepth4Schema, {
    maxProperties: 128,
  }),
]);
export type ShellUsage = Static<typeof ShellUsageSchema>;

export const ShellSnapshotSchema = Type.Object(
  {
    serverId: Type.String({ minLength: 1, maxLength: 512 }),
    revision: Type.Integer({ minimum: 0 }),
    cursor: Type.Integer({ minimum: 0 }),
    runtimes: Type.Array(ShellRuntimeSnapshotSchema, {
      maxItems: MAX_SHELL_INDEX_ITEMS,
    }),
    sessions: Type.Array(SessionIndexEntrySchema, {
      maxItems: MAX_SHELL_INDEX_ITEMS,
    }),
    projects: Type.Optional(
      Type.Array(ProjectSummarySchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
    checkouts: Type.Optional(
      Type.Array(CheckoutSummarySchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
    threads: Type.Optional(
      Type.Array(ThreadSummarySchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
    runs: Type.Optional(
      Type.Array(RunSummarySchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
    usage: Type.Optional(ShellUsageSchema),
    unread: Type.Array(NotificationEventSchema, {
      maxItems: MAX_SHELL_INDEX_ITEMS,
    }),
    shellProjection: Type.Optional(ShellProjectionSchema),
  },
  { additionalProperties: false },
);
export type ShellSnapshot = Static<typeof ShellSnapshotSchema>;

/** Canonical daemon event envelope used by reducers and resumable SSE. */
export const DashboardEventEnvelopeSchema = Type.Object(
  {
    cursor: Type.Integer({ minimum: 0 }),
    emittedAt: FiniteNumberSchema,
    /** Optional projection accompanying an event that changes dashboard state. */
    snapshot: Type.Optional(BrowserSnapshotSchema),
    runtimeId: Type.Optional(IdentifierSchema),
    runtimeEpoch: Type.Optional(IdentifierSchema),
    runtimeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionId: Type.Optional(IdentifierSchema),
    event: BridgeEventSchema,
  },
  { additionalProperties: false },
);
type DashboardEventEnvelopeStatic = Static<typeof DashboardEventEnvelopeSchema>;
export type DashboardEventEnvelope = Omit<
  DashboardEventEnvelopeStatic,
  'event'
> & {
  event: BridgeEvent;
};
export const EventEnvelopeSchema = DashboardEventEnvelopeSchema;
export type EventEnvelope = DashboardEventEnvelope;
export const BridgeEventEnvelopeSchema = DashboardEventEnvelopeSchema;
export type BridgeEventEnvelope = DashboardEventEnvelope;

export const SessionProjectionSchema = Type.Object(
  {
    id: IdentifierSchema,
    file: Type.Optional(Type.String({ maxLength: MAX_PATH })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    cwd: Type.Optional(Type.String({ maxLength: MAX_PATH })),
    leafId: Type.Optional(IdentifierSchema),
    entries: Type.Array(UnknownSchema),
  },
  { additionalProperties: false },
);
export type SessionProjection = Static<typeof SessionProjectionSchema>;

export const SessionHistorySchema = Type.Object(
  {
    version: Type.Literal(1),
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
    hasOlder: Type.Boolean(),
    nextBefore: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    /** The first returned entry continues an activity group on an older page. */
    leadingContinuation: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SessionHistory = Static<typeof SessionHistorySchema>;

/** Lightweight, indexed transcript landmarks. Payloads never cross this boundary. */
export const SessionOutlineLandmarkSchema = Type.Object(
  {
    id: IdentifierSchema,
    ordinal: Type.Integer({ minimum: 0 }),
    kind: Type.Union([
      Type.Literal('user'),
      Type.Literal('assistant'),
      Type.Literal('activity'),
    ]),
    label: Type.String({ minLength: 1, maxLength: 240 }),
    timestamp: Type.Optional(
      Type.Union([Type.String({ maxLength: 128 }), FiniteNumberSchema]),
    ),
  },
  { additionalProperties: false },
);
export type SessionOutlineLandmark = Static<
  typeof SessionOutlineLandmarkSchema
>;

export const SessionApiResponseSchema = Type.Object(
  {
    metadata: SessionIndexEntrySchema,
    entries: Type.Array(UnknownSchema),
    /** Complete lightweight outline; transcript payloads remain paginated. */
    outline: Type.Optional(
      Type.Readonly(
        Type.Array(SessionOutlineLandmarkSchema, { maxItems: 4096 }),
      ),
    ),
    /** Bounded history range and opaque cursor for explicit older-page loads. */
    history: Type.Optional(SessionHistorySchema),
    /** False when a new active session is not indexed and its runtime branch could not be serialized completely. */
    entriesComplete: Type.Optional(Type.Boolean()),
    /** Daemon generation that produced this response; optional for legacy clients. */
    serverId: Type.Optional(IdentifierSchema),
    /** Authoritative daemon cursor at which these entries were read. */
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Active runtime generation that supplied the branch, when available. */
    runtimeEpoch: Type.Optional(IdentifierSchema),
    /** Runtime sequence covered by the active branch snapshot. */
    runtimeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Whether the live overlay is reconciled through the response cursor. */
    completeThroughCursor: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SessionApiResponse = Static<typeof SessionApiResponseSchema>;

/** Input for the authoritative session query. `before` is file history only. */
export const SessionSnapshotRequestSchema = Type.Object(
  {
    sessionId: Type.String({
      minLength: 1,
      maxLength: 200,
      pattern: '^[a-zA-Z0-9._-]+$',
    }),
    before: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);
export type SessionSnapshotRequest = Static<
  typeof SessionSnapshotRequestSchema
>;

export const SessionActiveOverlaySchema = Type.Object(
  {
    runtimeId: Type.Optional(IdentifierSchema),
    runtimeEpoch: Type.Optional(IdentifierSchema),
    runtimeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    liveState: Type.Optional(RuntimeLiveStateSchema),
    /** Only in-flight entities are included; terminal history stays in JSONL. */
    messages: Type.Readonly(
      Type.Array(NormalizedMessagePayloadSchema, { maxItems: 256 }),
    ),
    tools: Type.Readonly(
      Type.Array(NormalizedToolPayloadSchema, { maxItems: 256 }),
    ),
    delegates: Type.Readonly(
      Type.Array(DelegateLiveRunSchema, { maxItems: 64 }),
    ),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SessionActiveOverlay = Static<typeof SessionActiveOverlaySchema>;

/**
 * Authoritative session response. `completeThroughCursor` is independent of
 * entriesComplete: the latter describes only the returned history page, while
 * the former describes whether the live overlay is complete through cursor.
 */
export const AuthoritativeSessionSnapshotSchema = Type.Object(
  {
    metadata: SessionIndexEntrySchema,
    entries: Type.Array(UnknownSchema, { maxItems: 2048 }),
    /** Complete lightweight outline; transcript payloads remain paginated. */
    outline: Type.Optional(
      Type.Readonly(
        Type.Array(SessionOutlineLandmarkSchema, { maxItems: 4096 }),
      ),
    ),
    history: Type.Optional(SessionHistorySchema),
    entriesComplete: Type.Boolean(),
    serverId: IdentifierSchema,
    /** Exact session-feed sequence at which history and the live overlay were read. */
    cursor: Type.Integer({ minimum: 0 }),
    runtimeEpoch: Type.Optional(IdentifierSchema),
    runtimeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    active: SessionActiveOverlaySchema,
    completeThroughCursor: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AuthoritativeSessionSnapshot = Static<
  typeof AuthoritativeSessionSnapshotSchema
>;
/** Descriptive aliases used by server and migration consumers. */
export const SessionRouteSnapshotSchema = AuthoritativeSessionSnapshotSchema;
export type SessionRouteSnapshot = AuthoritativeSessionSnapshot;
export const SessionSnapshotResponseV2Schema =
  AuthoritativeSessionSnapshotSchema;
export type SessionSnapshotResponseV2 = AuthoritativeSessionSnapshot;
/** Existing response spelling retained for v1 clients. */
export const SessionResponseSchema = SessionApiResponseSchema;
export type SessionResponse = SessionApiResponse;

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
const DelegateHistoryDetailsSchema = Type.Object(
  {
    task: Type.Optional(Type.String({ maxLength: MAX_DELEGATE_HISTORY_TASK })),
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
export const SessionSnapshotResponseSchema = Type.Object(
  { session: SessionProjectionSchema, cursor: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
export type SessionSnapshotResponse = Static<
  typeof SessionSnapshotResponseSchema
>;

/** Strict shell query response. */
export const ShellSnapshotResponseSchema = Type.Object(
  { snapshot: ShellSnapshotSchema, cursor: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
export type ShellSnapshotResponse = Static<typeof ShellSnapshotResponseSchema>;

/** Opaque tRPC tracked IDs. Numeric sequence values are never resumable alone. */
export const FeedCursorSchema = Type.String({
  minLength: 8,
  maxLength: 2048,
  pattern: '^[A-Za-z0-9_-]+$',
});
export type FeedCursor = Static<typeof FeedCursorSchema>;

export const FeedCaughtUpSchema = Type.Object(
  {
    type: Type.Literal('caught-up'),
    sequence: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type FeedCaughtUp = Static<typeof FeedCaughtUpSchema>;

export const ShellFeedDomainSchema = Type.Union([
  Type.Literal('runtime'),
  Type.Literal('session-index'),
  Type.Literal('notification'),
  Type.Literal('orchestration'),
  Type.Literal('usage'),
]);
export type ShellFeedDomain = Static<typeof ShellFeedDomainSchema>;

const ShellFeedEventProperties = {
  type: Type.Literal('shell-event'),
  sequence: Type.Integer({ minimum: 0 }),
  revision: Type.Integer({ minimum: 0 }),
  sessionId: Type.Optional(IdentifierSchema),
};
const ShellRuntimePatchSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('upsert'),
      runtime: ShellRuntimeSnapshotSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('remove'),
      runtimeId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
]);
const ShellSessionIndexDeltaSchema = Type.Object(
  {
    kind: Type.Literal('delta'),
    upsert: Type.Readonly(
      Type.Array(SessionIndexEntrySchema, {
        maxItems: MAX_SESSION_INDEX_DELTA_ITEMS,
      }),
    ),
    remove: Type.Readonly(
      Type.Array(IdentifierSchema, {
        maxItems: MAX_SESSION_INDEX_DELTA_ITEMS,
      }),
    ),
  },
  { additionalProperties: false },
);
const ShellSessionIndexReplaceSchema = Type.Object(
  {
    kind: Type.Literal('replace'),
    sessions: Type.Readonly(
      Type.Array(SessionIndexEntrySchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
  },
  { additionalProperties: false },
);
const ShellSessionIndexPatchSchema = Type.Union([
  ShellSessionIndexDeltaSchema,
  ShellSessionIndexReplaceSchema,
]);
const ShellOrchestrationPatchSchema = Type.Object(
  {
    projects: Type.Readonly(
      Type.Array(ProjectSummarySchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
    checkouts: Type.Readonly(
      Type.Array(CheckoutSummarySchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
    threads: Type.Readonly(
      Type.Array(ThreadSummarySchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
    runs: Type.Readonly(
      Type.Array(RunSummarySchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
    shellProjection: Type.Optional(ShellProjectionSchema),
  },
  { additionalProperties: false },
);
const ShellNotificationPatchSchema = Type.Object(
  {
    unread: Type.Readonly(
      Type.Array(NotificationEventSchema, { maxItems: MAX_SHELL_INDEX_ITEMS }),
    ),
    shellProjection: Type.Optional(ShellProjectionSchema),
  },
  { additionalProperties: false },
);
const ShellUsagePatchSchema = Type.Object(
  {
    usage: Type.Optional(ShellUsageSchema),
    shellProjection: Type.Optional(ShellProjectionSchema),
  },
  { additionalProperties: false },
);

export const ShellFeedDataSchema = Type.Union([
  ShellRuntimePatchSchema,
  ShellSessionIndexPatchSchema,
  ShellOrchestrationPatchSchema,
  ShellNotificationPatchSchema,
  ShellUsagePatchSchema,
]);
export const ShellFeedEventSchema = Type.Union([
  Type.Object(
    {
      ...ShellFeedEventProperties,
      domain: Type.Literal('runtime'),
      data: ShellRuntimePatchSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ShellFeedEventProperties,
      domain: Type.Literal('session-index'),
      data: ShellSessionIndexPatchSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ShellFeedEventProperties,
      domain: Type.Literal('orchestration'),
      data: ShellOrchestrationPatchSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ShellFeedEventProperties,
      domain: Type.Literal('notification'),
      data: ShellNotificationPatchSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ShellFeedEventProperties,
      domain: Type.Literal('usage'),
      data: ShellUsagePatchSchema,
    },
    { additionalProperties: false },
  ),
]);
export type ShellFeedData = Static<typeof ShellFeedDataSchema>;
export type ShellFeedEvent = Static<typeof ShellFeedEventSchema>;

export const ShellFeedSnapshotSchema = Type.Object(
  {
    type: Type.Literal('snapshot'),
    sequence: Type.Integer({ minimum: 0 }),
    snapshot: ShellSnapshotResponseSchema,
  },
  { additionalProperties: false },
);
export type ShellFeedSnapshot = Static<typeof ShellFeedSnapshotSchema>;
export const ShellFeedMessageSchema = Type.Union([
  ShellFeedSnapshotSchema,
  ShellFeedEventSchema,
  FeedCaughtUpSchema,
]);
export type ShellFeedMessage = Static<typeof ShellFeedMessageSchema>;

export const SessionFeedEventSchema = Type.Object(
  {
    type: Type.Literal('session-event'),
    sequence: Type.Integer({ minimum: 0 }),
    sessionId: IdentifierSchema,
    runtimeId: Type.Optional(IdentifierSchema),
    runtimeEpoch: Type.Optional(IdentifierSchema),
    runtimeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    event: BridgeEventSchema,
  },
  { additionalProperties: false },
);
export type SessionFeedEvent = Static<typeof SessionFeedEventSchema>;
export const SessionFeedSnapshotSchema = Type.Object(
  {
    type: Type.Literal('snapshot'),
    sequence: Type.Integer({ minimum: 0 }),
    snapshot: AuthoritativeSessionSnapshotSchema,
  },
  { additionalProperties: false },
);
export type SessionFeedSnapshot = Static<typeof SessionFeedSnapshotSchema>;
export const SessionFeedMessageSchema = Type.Union([
  SessionFeedSnapshotSchema,
  SessionFeedEventSchema,
  FeedCaughtUpSchema,
]);
export type SessionFeedMessage = Static<typeof SessionFeedMessageSchema>;

export const ShellFeedInputSchema = Type.Object(
  {
    /** Injected exclusively by tRPC's automatic subscription reconnect. */
    lastEventId: Type.Optional(FeedCursorSchema),
  },
  { additionalProperties: false },
);
export type ShellFeedInput = Static<typeof ShellFeedInputSchema>;
export const SessionFeedInputSchema = Type.Object(
  {
    sessionId: IdentifierSchema,
    /** Injected exclusively by tRPC's automatic subscription reconnect. */
    lastEventId: Type.Optional(FeedCursorSchema),
  },
  { additionalProperties: false },
);
export type SessionFeedInput = Static<typeof SessionFeedInputSchema>;

export const StartRuntimeRequestSchema = Type.Object(
  {
    /** Persisted orchestration launch identity. */
    projectId: Type.Optional(IdentifierSchema),
    checkoutId: Type.Optional(IdentifierSchema),
    /** Internal orchestration identity. Browser launches may omit it. */
    runtimeId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID })),
    /** Explicit cwd within the selected checkout. */
    checkoutCwd: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_PATH }),
    ),
    /** Managed orchestration launches may restrict Pi to read-only tools. */
    mode: Type.Optional(
      Type.Union([Type.Literal('read'), Type.Literal('write')]),
    ),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    model: Type.Optional(
      Type.Object(
        {
          provider: Type.String({ minLength: 1, maxLength: 200 }),
          model: Type.String({ minLength: 1, maxLength: 300 }),
          thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        },
        { additionalProperties: false },
      ),
    ),
    initialPrompt: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100_000 }),
    ),
  },
  { additionalProperties: false },
);
export type StartRuntimeRequest = Static<typeof StartRuntimeRequestSchema>;

/** Durable browser start/resume mutation. The command ID is not part of the
 * manager's launch payload and is stripped at the application boundary. */
export const StartRuntimeMutationInputSchema = Type.Object(
  {
    ...StartRuntimeRequestSchema.properties,
    commandId: LifecycleCommandIdSchema,
  },
  { additionalProperties: false },
);
export type StartRuntimeMutationInput = Static<
  typeof StartRuntimeMutationInputSchema
>;
export const StartRuntimeInputSchema = StartRuntimeMutationInputSchema;
export type StartRuntimeInput = StartRuntimeMutationInput;

export const LifecycleMutationStatusSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('already-completed'),
]);
export type LifecycleMutationStatus = Static<
  typeof LifecycleMutationStatusSchema
>;

export const StartRuntimeMutationOutputSchema = Type.Object(
  {
    commandId: LifecycleCommandIdSchema,
    status: LifecycleMutationStatusSchema,
    result: Type.Object(
      { runtimeId: IdentifierSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type StartRuntimeMutationOutput = Static<
  typeof StartRuntimeMutationOutputSchema
>;
export const StartRuntimeOutputSchema = StartRuntimeMutationOutputSchema;
export type StartRuntimeOutput = StartRuntimeMutationOutput;

export const RestartRuntimeMutationInputSchema = Type.Object(
  { runtimeId: IdentifierSchema, commandId: LifecycleCommandIdSchema },
  { additionalProperties: false },
);
export type RestartRuntimeMutationInput = Static<
  typeof RestartRuntimeMutationInputSchema
>;
export const RestartRuntimeInputSchema = RestartRuntimeMutationInputSchema;
export type RestartRuntimeInput = RestartRuntimeMutationInput;

export const RestartRuntimeMutationOutputSchema = Type.Object(
  {
    commandId: LifecycleCommandIdSchema,
    status: LifecycleMutationStatusSchema,
    result: Type.Object(
      { runtimeId: IdentifierSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type RestartRuntimeMutationOutput = Static<
  typeof RestartRuntimeMutationOutputSchema
>;
export const RestartRuntimeOutputSchema = RestartRuntimeMutationOutputSchema;
export type RestartRuntimeOutput = RestartRuntimeMutationOutput;

export const StopRuntimeMutationInputSchema = Type.Object(
  {
    runtimeId: IdentifierSchema,
    commandId: LifecycleCommandIdSchema,
    force: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type StopRuntimeMutationInput = Static<
  typeof StopRuntimeMutationInputSchema
>;
export const StopRuntimeInputSchema = StopRuntimeMutationInputSchema;
export type StopRuntimeInput = StopRuntimeMutationInput;

export const StopRuntimeMutationOutputSchema = Type.Object(
  {
    commandId: LifecycleCommandIdSchema,
    status: LifecycleMutationStatusSchema,
    result: Type.Object(
      { runtimeId: IdentifierSchema, stopped: Type.Literal(true) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type StopRuntimeMutationOutput = Static<
  typeof StopRuntimeMutationOutputSchema
>;
export const StopRuntimeOutputSchema = StopRuntimeMutationOutputSchema;
export type StopRuntimeOutput = StopRuntimeMutationOutput;

export const SessionRenameRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);
export type SessionRenameRequest = Static<typeof SessionRenameRequestSchema>;

export const RenameSessionMutationInputSchema = Type.Object(
  {
    sessionId: IdentifierSchema,
    commandId: LifecycleCommandIdSchema,
    name: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);
export type RenameSessionMutationInput = Static<
  typeof RenameSessionMutationInputSchema
>;
export const SessionRenameMutationInputSchema =
  RenameSessionMutationInputSchema;
export type SessionRenameMutationInput = RenameSessionMutationInput;
export const RenameSessionInputSchema = RenameSessionMutationInputSchema;
export type RenameSessionInput = RenameSessionMutationInput;

export const RenameSessionMutationOutputSchema = Type.Object(
  {
    commandId: LifecycleCommandIdSchema,
    status: LifecycleMutationStatusSchema,
    result: Type.Object(
      {
        sessionId: IdentifierSchema,
        name: Type.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type RenameSessionMutationOutput = Static<
  typeof RenameSessionMutationOutputSchema
>;
export const SessionRenameMutationOutputSchema =
  RenameSessionMutationOutputSchema;
export type SessionRenameMutationOutput = RenameSessionMutationOutput;
export const RenameSessionOutputSchema = RenameSessionMutationOutputSchema;
export type RenameSessionOutput = RenameSessionMutationOutput;
