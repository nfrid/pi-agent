/**
 * Versioned, framework-independent contracts for the Pi dashboard bridge and
 * browser API.  TypeBox schemas are the source of truth; the exported
 * interfaces are Static-derived aliases so transports do not need to repeat
 * structural validation.
 */
import {
  CapabilitySummarySchema,
  ExtensionManifestSummarySchema,
  parseRuntimeCapabilitySnapshot as parseExtensionCapabilitySnapshot,
  RuntimeCapabilitySnapshotSchema,
  tryParseRuntimeCapabilitySnapshot as tryParseExtensionCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import { type Static, type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 512 * 1024;
/** Capability contracts and replay bounds are optional protocol-v1 extensions. */
export {
  MAX_NON_IDEMPOTENT_ACTION_IDS,
  RuntimeCapabilitySnapshotSchema,
  safeRuntimeCapabilitySnapshot,
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

const MAX_ID = 256;
const MAX_PATH = 4096;
const MAX_TEXT = 100_000;
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
const NonEmptyTextSchema = Type.String({ minLength: 1, maxLength: MAX_TEXT });
const FiniteNumberSchema = Type.Number();
const UnknownSchema = Type.Unknown();

export const RuntimeLiveStateSchema = Type.Union([
  Type.Literal('idle'),
  Type.Literal('working'),
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

/** A bounded, framework-free live surface contributed by a Pi extension. */
export const RuntimeExtensionSurfaceSchema = Type.Object(
  {
    id: IdentifierSchema,
    rendererId: IdentifierSchema,
    viewModel: UnknownSchema,
    placement: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);
export type RuntimeExtensionSurface = Static<
  typeof RuntimeExtensionSurfaceSchema
>;
/** Compatibility spelling for consumers that call these live surfaces. */
export const LiveExtensionSurfaceSchema = RuntimeExtensionSurfaceSchema;
export type LiveExtensionSurface = RuntimeExtensionSurface;
export const MAX_RUNTIME_EXTENSION_SURFACES = 64;

const InteractionChoiceSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 512 }),
    value: Type.String({ minLength: 1, maxLength: 512 }),
    description: Type.Optional(
      Type.String({ minLength: 1, maxLength: 10_000 }),
    ),
    preview: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT })),
    custom: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type InteractionChoice = Static<typeof InteractionChoiceSchema>;

export const InteractionSnapshotSchema = Type.Object(
  {
    id: IdentifierSchema,
    type: Type.Literal('ask_user'),
    question: NonEmptyTextSchema,
    choices: Type.Readonly(
      Type.Array(InteractionChoiceSchema, { maxItems: 128 }),
    ),
    allowCustom: Type.Boolean(),
    customLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    /** Known contribution renderer; absent means generic interaction fallback. */
    rendererId: Type.Optional(IdentifierSchema),
    /** Validated renderer view model, retained opaque at protocol v1. */
    viewModel: Type.Optional(UnknownSchema),
    answerActionId: Type.Optional(IdentifierSchema),
    cancelActionId: Type.Optional(IdentifierSchema),
    createdAt: FiniteNumberSchema,
  },
  { additionalProperties: false },
);
type InteractionSnapshotStatic = Static<typeof InteractionSnapshotSchema>;
export type InteractionSnapshot = Omit<InteractionSnapshotStatic, 'choices'> & {
  readonly choices: readonly InteractionChoice[];
};

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
  workspaceHint: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  tmux: Type.Optional(
    Type.Object(
      {
        session: Type.String({ minLength: 1, maxLength: 512 }),
        windowId: Type.String({ minLength: 1, maxLength: 128 }),
        paneId: Type.String({ minLength: 1, maxLength: 128 }),
        displayTarget: Type.String({ minLength: 1, maxLength: 768 }),
      },
      { additionalProperties: false },
    ),
  ),
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
  pendingInteractions: Type.Readonly(Type.Array(InteractionSnapshotSchema)),
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
  'session' | 'pendingInteractions' | 'queueDrafts' | 'extensionSurfaces'
> & {
  session: SessionSnapshot;
  readonly pendingInteractions: readonly InteractionSnapshot[];
  readonly queueDrafts?: readonly QueueDraft[];
  readonly extensionSurfaces?: readonly RuntimeExtensionSurface[];
};

// Type.Partial needs its options argument to preserve strict unknown-field
// rejection in TypeBox 1.x.
export const RuntimeSnapshotPatchSchema = Type.Partial(RuntimeSnapshotSchema, {
  additionalProperties: false,
});
type RuntimeSnapshotPatchStatic = Static<typeof RuntimeSnapshotPatchSchema>;
export type RuntimeSnapshotPatch = Omit<
  RuntimeSnapshotPatchStatic,
  'session' | 'pendingInteractions' | 'queueDrafts' | 'extensionSurfaces'
> & {
  session?: SessionSnapshot;
  pendingInteractions?: readonly InteractionSnapshot[];
  queueDrafts?: readonly QueueDraft[];
  extensionSurfaces?: readonly RuntimeExtensionSurface[];
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
const InteractionRequestedEventSchema = Type.Object(
  {
    type: Type.Literal('interaction.requested'),
    interaction: InteractionSnapshotSchema,
  },
  { additionalProperties: false },
);
const InteractionResolvedEventSchema = Type.Object(
  {
    type: Type.Literal('interaction.resolved'),
    interactionId: IdentifierSchema,
    resolution: UnknownSchema,
  },
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
  MessageEventSchema,
  ToolEventSchema,
  AgentSettledEventSchema,
  InteractionRequestedEventSchema,
  InteractionResolvedEventSchema,
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
  | Static<typeof MessageEventSchema>
  | Static<typeof ToolEventSchema>
  | Static<typeof AgentSettledEventSchema>
  | (Omit<Static<typeof InteractionRequestedEventSchema>, 'interaction'> & {
      interaction: InteractionSnapshot;
    })
  | Static<typeof InteractionResolvedEventSchema>
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
    type: Type.Union([Type.Literal('abort'), Type.Literal('shutdown')]),
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
const AnswerCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Literal('interaction.answer'),
    interactionId: IdentifierSchema,
    answer: UnknownSchema,
  },
  { additionalProperties: false },
);
const CancelCommandSchema = Type.Object(
  {
    ...BridgeCommandBaseProperties,
    type: Type.Literal('interaction.cancel'),
    interactionId: IdentifierSchema,
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
  AnswerCommandSchema,
  CancelCommandSchema,
  SemanticActionCommandSchema,
]);
export type BridgeCommand = Static<typeof BridgeCommandSchema>;
export type BridgeCommandBase = { id: string };

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

export const WorkspaceTargetSchema = Type.Object(
  {
    id: IdentifierSchema,
    name: Type.String({ minLength: 1, maxLength: 512 }),
    path: Type.String({ maxLength: MAX_PATH }),
    canonicalPath: Type.String({ maxLength: MAX_PATH }),
    gitRoot: Type.Optional(Type.String({ maxLength: MAX_PATH })),
    source: Type.Union([
      Type.Literal('tmux'),
      Type.Literal('sesh-config'),
      Type.Literal('zoxide'),
      Type.Literal('directory'),
    ]),
    tmuxSession: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type WorkspaceTarget = Static<typeof WorkspaceTargetSchema>;

export const SessionIndexEntrySchema = Type.Object(
  {
    id: IdentifierSchema,
    file: Type.String({ maxLength: MAX_PATH }),
    cwd: Type.String({ maxLength: MAX_PATH }),
    workspaceId: Type.Optional(IdentifierSchema),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
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

export const BrowserSnapshotSchema = Type.Object(
  {
    /** Changes whenever the dashboard daemon process restarts. */
    serverId: Type.String({ minLength: 1, maxLength: 512 }),
    /** Compatibility revision retained for v1 websocket clients. */
    revision: Type.Integer({ minimum: 0 }),
    /** Authoritative position in the daemon-global resumable event stream. */
    cursor: Type.Integer({ minimum: 0 }),
    runtimes: Type.Array(RuntimeSnapshotSchema),
    workspaces: Type.Array(WorkspaceTargetSchema),
    sessions: Type.Array(SessionIndexEntrySchema),
    usage: Type.Optional(UnknownSchema),
    unread: Type.Array(NotificationEventSchema),
  },
  { additionalProperties: false },
);
type BrowserSnapshotStatic = Static<typeof BrowserSnapshotSchema>;
export type BrowserSnapshot = Omit<
  BrowserSnapshotStatic,
  'runtimes' | 'workspaces' | 'sessions' | 'unread'
> & {
  readonly runtimes: readonly RuntimeSnapshot[];
  readonly workspaces: readonly WorkspaceTarget[];
  readonly sessions: readonly SessionIndexEntry[];
  readonly unread: readonly NotificationEvent[];
};

/** Messages emitted on the authenticated browser websocket (v1 compatible). */
const BrowserSnapshotMessageSchema = Type.Object(
  { type: Type.Literal('snapshot'), snapshot: BrowserSnapshotSchema },
  { additionalProperties: false },
);
const BrowserEventMessageSchema = Type.Object(
  {
    type: Type.Literal('event'),
    serverId: Type.String({ minLength: 1, maxLength: 512 }),
    revision: Type.Integer({ minimum: 0 }),
    runtimeId: IdentifierSchema,
    event: BridgeEventSchema,
    /** Transcript deltas omit the state snapshot to keep streaming bounded. */
    snapshot: Type.Optional(BrowserSnapshotSchema),
  },
  { additionalProperties: false },
);
export const DashboardMessageSchema = Type.Union([
  BrowserSnapshotMessageSchema,
  BrowserEventMessageSchema,
]);
type DashboardMessageStatic = Static<typeof DashboardMessageSchema>;
export type DashboardMessage =
  | Extract<DashboardMessageStatic, { type: 'snapshot' }>
  | (Omit<
      Extract<DashboardMessageStatic, { type: 'event' }>,
      'event' | 'snapshot'
    > & {
      event: BridgeEvent;
      snapshot?: BrowserSnapshot;
    });
export const BrowserMessageSchema = DashboardMessageSchema;
export type BrowserMessage = DashboardMessage;

/** Canonical daemon event envelope used by reducers and future resumable transports. */
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

export const SessionApiResponseSchema = Type.Object(
  {
    metadata: SessionIndexEntrySchema,
    entries: Type.Array(UnknownSchema),
    /** Daemon generation that produced this response; optional for legacy clients. */
    serverId: Type.Optional(IdentifierSchema),
    /** Authoritative daemon cursor at which these entries were read. */
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Active runtime generation that supplied the branch, when available. */
    runtimeEpoch: Type.Optional(IdentifierSchema),
    /** Runtime sequence covered by the active branch snapshot. */
    runtimeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type SessionApiResponse = Static<typeof SessionApiResponseSchema>;
/** Existing response spelling retained for v1 clients. */
export const SessionResponseSchema = SessionApiResponseSchema;
export type SessionResponse = SessionApiResponse;
export const SessionSnapshotResponseSchema = Type.Object(
  { session: SessionProjectionSchema, cursor: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
export type SessionSnapshotResponse = Static<
  typeof SessionSnapshotResponseSchema
>;

export const DashboardSnapshotResponseSchema = Type.Object(
  { snapshot: BrowserSnapshotSchema, cursor: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
export type DashboardSnapshotResponse = Static<
  typeof DashboardSnapshotResponseSchema
>;

/**
 * SSE-only snapshot records are separate from event envelopes so a client can
 * distinguish an authoritative replacement from a reducer input.
 */
export const DashboardSnapshotStreamSchema = Type.Object(
  {
    type: Type.Literal('snapshot'),
    cursor: Type.Integer({ minimum: 0 }),
    emittedAt: FiniteNumberSchema,
    snapshot: BrowserSnapshotSchema,
  },
  { additionalProperties: false },
);
export type DashboardSnapshotStream = Static<
  typeof DashboardSnapshotStreamSchema
>;
export const DashboardStreamMessageSchema = Type.Union([
  DashboardEventEnvelopeSchema,
  DashboardSnapshotStreamSchema,
]);
export type DashboardStreamMessage = Static<
  typeof DashboardStreamMessageSchema
>;

export const StartRuntimeRequestSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 256 }),
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
    acknowledgeSharedWorkingDirectory: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type StartRuntimeRequest = Static<typeof StartRuntimeRequestSchema>;

export const SessionRenameRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);
export type SessionRenameRequest = Static<typeof SessionRenameRequestSchema>;

const WORKSPACE_SOURCE_PRIORITY: Record<WorkspaceTarget['source'], number> = {
  tmux: 3,
  'sesh-config': 2,
  directory: 1,
  zoxide: 0,
};

export function workspaceSourcePriority(
  source: WorkspaceTarget['source'],
): number {
  return WORKSPACE_SOURCE_PRIORITY[source];
}

/** Choose the closest containing workspace, preferring explicit sources on ties. */
export function workspaceForPath(
  value: string,
  workspaces: readonly WorkspaceTarget[],
): WorkspaceTarget | undefined {
  let best: WorkspaceTarget | undefined;
  for (const workspace of workspaces) {
    const root = workspace.canonicalPath.replace(/\/$/u, '') || '/';
    const contains =
      value === root || value.startsWith(root === '/' ? root : `${root}/`);
    if (!contains) continue;
    const bestRoot = best
      ? best.canonicalPath.replace(/\/$/u, '') || '/'
      : undefined;
    if (
      !best ||
      (bestRoot !== undefined && root.length > bestRoot.length) ||
      (bestRoot !== undefined &&
        root.length === bestRoot.length &&
        workspaceSourcePriority(workspace.source) >
          workspaceSourcePriority(best.source))
    )
      best = workspace;
  }
  return best;
}

export const SESSION_TITLE_MAX_LENGTH = 96;
export const SESSION_NAME_MAX_LENGTH = 512;

/** Normalize a user message into a compact, stable dashboard title. */
export function normalizeSessionTitle(value: string): string | undefined {
  const normalized = [...value.normalize('NFKC')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length <= SESSION_TITLE_MAX_LENGTH
    ? normalized
    : `${characters.slice(0, SESSION_TITLE_MAX_LENGTH - 1).join('')}…`;
}

function textFromMessageContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part) || typeof part.text !== 'string') return '';
      return part.text;
    })
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

/** Return the first non-empty user message title in Pi session entries. */
export function deriveSessionTitle(
  entries: readonly unknown[],
): string | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'message') continue;
    const message = isRecord(entry.message) ? entry.message : entry;
    if (message.role !== 'user') continue;
    const text = textFromMessageContent(message.content);
    const title = text ? normalizeSessionTitle(text) : undefined;
    if (title) return title;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max = 4096): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= max
  );
}

function safeIdentifier(value: unknown, max: number): value is string {
  return (
    nonEmptyString(value, max) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function normalizeSchemaValue<T extends TSchema>(
  schema: T,
  value: unknown,
  label: string,
): Static<T> {
  if (!Value.Check(schema, value)) throw new Error(`Invalid ${label}.`);
  return value as Static<T>;
}

export function parseSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  label = 'value',
): Static<T> {
  return normalizeSchemaValue(schema, value, label);
}
export function tryParseSchema<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> | undefined {
  return Value.Check(schema, value) ? (value as Static<T>) : undefined;
}

export function isRuntimeLiveState(value: unknown): value is RuntimeLiveState {
  return Value.Check(RuntimeLiveStateSchema, value);
}

function validateImages(value: unknown): BridgeImageAttachment[] {
  if (value === undefined) return [];
  if (
    !Value.Check(
      Type.Array(BridgeImageAttachmentSchema, { maxItems: 4 }),
      value,
    )
  )
    throw new Error('Invalid image attachments.');
  const images = value as BridgeImageAttachment[];
  for (const image of images)
    if (!safeIdentifier(image.path, MAX_PATH))
      throw new Error('Invalid image attachment.');
  return images;
}

/** Remove base64 image bytes before values cross dashboard snapshot boundaries. */
export function redactImageData(value: unknown): unknown {
  if (
    typeof value === 'string' &&
    /^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)
  )
    return '[image data omitted]';
  if (Array.isArray(value)) return value.map(redactImageData);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'data' && (value.type === 'image' || value.type === 'base64'))
      continue;
    if (
      key === 'source' &&
      isRecord(item) &&
      value.type === 'image' &&
      item.type === 'base64'
    ) {
      const { data: _data, ...source } = item;
      result.source = { ...source, omitted: true };
      continue;
    }
    result[key] = redactImageData(item);
  }
  if ((value.type === 'image' || value.type === 'base64') && 'data' in value)
    result.omitted = true;
  return result;
}

/** Defense-in-depth redaction for untrusted runtime bridge events. */
export function redactBridgeEvent(event: BridgeEvent): BridgeEvent {
  return redactImageData(event) as BridgeEvent;
}

export function validateSessionName(value: unknown): string {
  if (!safeIdentifier(value, SESSION_NAME_MAX_LENGTH))
    throw new Error('Invalid session name.');
  return value.trim();
}

export function parseSessionRenameRequest(
  value: unknown,
): SessionRenameRequest {
  if (!Value.Check(SessionRenameRequestSchema, value))
    throw new Error('Invalid session rename request.');
  return { name: validateSessionName((value as SessionRenameRequest).name) };
}
export const tryParseSessionRenameRequest = (
  value: unknown,
): SessionRenameRequest | undefined => {
  try {
    return parseSessionRenameRequest(value);
  } catch {
    return undefined;
  }
};
export const validateSessionRenameRequest = parseSessionRenameRequest;

export function parseBridgeCommand(value: unknown): BridgeCommand {
  if (!Value.Check(BridgeCommandSchema, value))
    throw new Error('Invalid bridge command.');
  const command = value as BridgeCommand;
  if (
    command.type === 'queue.add' ||
    command.type === 'queueDraft.add' ||
    command.type === 'queue.update' ||
    command.type === 'queueDraft.update' ||
    command.type === 'queue.remove' ||
    command.type === 'queueDraft.remove'
  ) {
    const queueCommand = command as {
      clientId: string;
      text?: string;
      mode?: QueueDraftMode;
    };
    if (
      !onlyKeys(
        command as Record<string, unknown>,
        new Set(['id', 'type', 'clientId', 'mode', 'text']),
      ) ||
      !safeIdentifier(queueCommand.clientId, MAX_ID)
    )
      throw new Error('Invalid queue draft client id.');
    if (queueCommand.text !== undefined) {
      const text = queueCommand.text.trim();
      if (!text) throw new Error('Queue draft text is required.');
      return { ...command, text } as BridgeCommand;
    }
    return command;
  }
  if (
    command.type === 'prompt' ||
    command.type === 'steer' ||
    command.type === 'followUp'
  ) {
    if (
      !onlyKeys(
        command as Record<string, unknown>,
        new Set(['id', 'type', 'text', 'images']),
      )
    )
      throw new Error(`Invalid ${command.type} command.`);
    const text = command.text.trim();
    const images = validateImages(command.images);
    if (!text && images.length === 0)
      throw new Error('Command text or an image is required.');
    return { ...command, text, ...(images.length > 0 ? { images } : {}) };
  }
  if (command.type === 'setModel') {
    if (
      !safeIdentifier(command.provider, 200) ||
      !safeIdentifier(command.model, 300)
    )
      throw new Error('Invalid model selection.');
  }
  if (command.type === 'setThinking' && !safeIdentifier(command.level, 64))
    throw new Error('Invalid thinking level.');
  if (command.type === 'setSessionName') {
    if (
      !onlyKeys(
        command as Record<string, unknown>,
        new Set(['id', 'type', 'name']),
      )
    )
      throw new Error('Invalid session name command.');
    return { ...command, name: validateSessionName(command.name) };
  }
  if (
    (command.type === 'interaction.answer' ||
      command.type === 'interaction.cancel') &&
    !safeIdentifier(command.interactionId, 128)
  )
    throw new Error('Invalid interaction id.');
  if (command.type === 'action.invoke') {
    if (
      !onlyKeys(
        command as Record<string, unknown>,
        new Set(['id', 'type', 'actionId', 'input']),
      ) ||
      !safeIdentifier(command.actionId, MAX_ID)
    )
      throw new Error('Invalid semantic action invocation.');
  }
  return command;
}
export const validateBridgeCommand = parseBridgeCommand;
export const tryParseBridgeCommand = (
  value: unknown,
): BridgeCommand | undefined => {
  try {
    return parseBridgeCommand(value);
  } catch {
    return undefined;
  }
};

function validateRuntimeSnapshotCapabilities(
  snapshot: Pick<RuntimeSnapshot, 'capabilities'>,
): void {
  if (snapshot.capabilities !== undefined)
    parseExtensionCapabilitySnapshot(snapshot.capabilities);
}

function validateHelloCapabilities(
  capabilities: RuntimeHelloCapabilities | undefined,
): void {
  if (!capabilities) return;
  if (capabilities.extensions)
    parseExtensionCapabilitySnapshot(capabilities.extensions);
  if (capabilities.extensionCapabilities)
    parseExtensionCapabilitySnapshot(capabilities.extensionCapabilities);
  if (
    capabilities.capabilitySummaries !== undefined ||
    capabilities.manifests !== undefined
  )
    parseExtensionCapabilitySnapshot({
      version: 1,
      capabilities: capabilities.capabilitySummaries ?? [],
      manifests: capabilities.manifests ?? [],
    });
}

/**
 * Validate capability snapshots after structural protocol validation. This is
 * kept separate from TypeBox because duplicate contribution IDs are semantic
 * invalidity, not a JSON-shape constraint.
 */
function validateBridgeEventCapabilities(event: BridgeEvent): void {
  if (event.type === 'runtime.hello') {
    validateRuntimeSnapshotCapabilities(event.snapshot);
    validateHelloCapabilities(event.capabilities);
  } else if (
    (event.type === 'runtime.heartbeat' ||
      event.type === 'runtime.stateChanged') &&
    event.snapshot
  )
    validateRuntimeSnapshotCapabilities(event.snapshot);
}

export function parseBridgeEvent(value: unknown): BridgeEvent {
  const event = parseSchema(
    BridgeEventSchema,
    value,
    'bridge event',
  ) as unknown as BridgeEvent;
  validateBridgeEventCapabilities(event);
  return event;
}
export function tryParseBridgeEvent(value: unknown): BridgeEvent | undefined {
  try {
    return parseBridgeEvent(value);
  } catch {
    return undefined;
  }
}
export function isBridgeEvent(value: unknown): value is BridgeEvent {
  return tryParseBridgeEvent(value) !== undefined;
}

export function parseBridgeFrame(value: unknown): BridgeFrame {
  const frame = parseSchema(
    BridgeFrameSchema,
    value,
    'protocol frame',
  ) as unknown as BridgeFrame;
  if (frame.kind === 'event') validateBridgeEventCapabilities(frame.event);
  return frame;
}
export function tryParseBridgeFrame(value: unknown): BridgeFrame | undefined {
  try {
    return parseBridgeFrame(value);
  } catch {
    return undefined;
  }
}

function frameBytes(line: string | Uint8Array): number {
  return typeof line === 'string'
    ? new TextEncoder().encode(line).byteLength
    : line.byteLength;
}

export function parseFrame(line: string | Uint8Array): BridgeFrame {
  if (frameBytes(line) > MAX_FRAME_BYTES)
    throw new Error('Protocol frame exceeds size limit.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof line === 'string' ? line : new TextDecoder().decode(line),
    ) as unknown;
  } catch {
    throw new Error('Invalid protocol frame.');
  }
  return parseBridgeFrame(parsed);
}

export function serializeFrame(frame: unknown): string {
  const parsed = parseBridgeFrame(frame);
  const line = JSON.stringify(parsed);
  if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES)
    throw new Error('Protocol frame exceeds size limit.');
  return `${line}\n`;
}

export function parseStartRuntimeRequest(value: unknown): StartRuntimeRequest {
  if (!Value.Check(StartRuntimeRequestSchema, value)) {
    if (!isRecord(value) || !safeIdentifier(value.workspaceId, 256))
      throw new Error('workspaceId is required.');
    if (
      value.initialPrompt !== undefined &&
      !nonEmptyString(value.initialPrompt, 100_000)
    )
      throw new Error('Invalid initial prompt.');
    if (value.sessionId !== undefined && !safeIdentifier(value.sessionId, 256))
      throw new Error('Invalid sessionId.');
    if (value.name !== undefined && !safeIdentifier(value.name, 120))
      throw new Error('Invalid runtime name.');
    throw new Error('Invalid start runtime request.');
  }
  const input = value as StartRuntimeRequest;
  const result: StartRuntimeRequest = { workspaceId: input.workspaceId };
  if (input.sessionId !== undefined && !safeIdentifier(input.sessionId, 256))
    throw new Error('Invalid sessionId.');
  if (input.name !== undefined && !safeIdentifier(input.name, 120))
    throw new Error('Invalid runtime name.');
  if (
    input.initialPrompt !== undefined &&
    !nonEmptyString(input.initialPrompt, 100_000)
  )
    throw new Error('Invalid initial prompt.');
  if (input.sessionId) result.sessionId = input.sessionId;
  if (input.name) result.name = input.name;
  if (input.initialPrompt) result.initialPrompt = input.initialPrompt;
  if (input.acknowledgeSharedWorkingDirectory !== undefined)
    result.acknowledgeSharedWorkingDirectory =
      input.acknowledgeSharedWorkingDirectory;
  if (input.model) {
    if (
      !safeIdentifier(input.model.provider, 200) ||
      !safeIdentifier(input.model.model, 300)
    )
      throw new Error('Invalid model.');
    if (
      input.model.thinking !== undefined &&
      !safeIdentifier(input.model.thinking, 64)
    )
      throw new Error('Invalid thinking level.');
    result.model = {
      provider: input.model.provider,
      model: input.model.model,
      ...(input.model.thinking ? { thinking: input.model.thinking } : {}),
    };
  }
  return result;
}
export const validateStartRuntimeRequest = parseStartRuntimeRequest;
export const tryParseStartRuntimeRequest = (
  value: unknown,
): StartRuntimeRequest | undefined => {
  try {
    return parseStartRuntimeRequest(value);
  } catch {
    return undefined;
  }
};

export function parseNormalizedMessagePayload(
  value: unknown,
): NormalizedMessagePayload {
  return parseSchema(
    NormalizedMessagePayloadSchema,
    value,
    'normalized message payload',
  );
}
export function tryParseNormalizedMessagePayload(
  value: unknown,
): NormalizedMessagePayload | undefined {
  return tryParseSchema(NormalizedMessagePayloadSchema, value);
}
export function parseNormalizedToolPayload(
  value: unknown,
): NormalizedToolPayload {
  return parseSchema(
    NormalizedToolPayloadSchema,
    value,
    'normalized tool payload',
  );
}
export function tryParseNormalizedToolPayload(
  value: unknown,
): NormalizedToolPayload | undefined {
  return tryParseSchema(NormalizedToolPayloadSchema, value);
}
export function parseSessionSnapshotPatch(
  value: unknown,
): SessionSnapshotPatch {
  return parseSchema(
    SessionSnapshotPatchSchema,
    value,
    'session snapshot patch',
  );
}
export function tryParseSessionSnapshotPatch(
  value: unknown,
): SessionSnapshotPatch | undefined {
  return tryParseSchema(SessionSnapshotPatchSchema, value);
}
export function parseInteractionSnapshot(value: unknown): InteractionSnapshot {
  return parseSchema(InteractionSnapshotSchema, value, 'interaction');
}
export function tryParseInteractionSnapshot(
  value: unknown,
): InteractionSnapshot | undefined {
  return tryParseSchema(InteractionSnapshotSchema, value);
}
function validateBrowserSnapshotCapabilities(snapshot: BrowserSnapshot): void {
  for (const runtime of snapshot.runtimes)
    validateRuntimeSnapshotCapabilities(runtime);
}

function validateDashboardEventEnvelopeCapabilities(
  value: DashboardEventEnvelope,
): void {
  validateBridgeEventCapabilities(value.event);
  if (value.snapshot) validateBrowserSnapshotCapabilities(value.snapshot);
}

export function parseRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  const snapshot = parseSchema(
    RuntimeSnapshotSchema,
    value,
    'runtime snapshot',
  );
  validateRuntimeSnapshotCapabilities(snapshot);
  return snapshot;
}
export function tryParseRuntimeSnapshot(
  value: unknown,
): RuntimeSnapshot | undefined {
  try {
    return parseRuntimeSnapshot(value);
  } catch {
    return undefined;
  }
}
export function parseRuntimeSnapshotPatch(
  value: unknown,
): RuntimeSnapshotPatch {
  const patch = parseSchema(
    RuntimeSnapshotPatchSchema,
    value,
    'runtime snapshot patch',
  );
  validateRuntimeSnapshotCapabilities(patch);
  return patch;
}
export function tryParseRuntimeSnapshotPatch(
  value: unknown,
): RuntimeSnapshotPatch | undefined {
  try {
    return parseRuntimeSnapshotPatch(value);
  } catch {
    return undefined;
  }
}
export function parseDashboardEventEnvelope(
  value: unknown,
): DashboardEventEnvelope {
  const envelope = parseSchema(
    DashboardEventEnvelopeSchema,
    value,
    'dashboard event envelope',
  );
  validateDashboardEventEnvelopeCapabilities(envelope);
  return envelope;
}
export function tryParseDashboardEventEnvelope(
  value: unknown,
): DashboardEventEnvelope | undefined {
  try {
    return parseDashboardEventEnvelope(value);
  } catch {
    return undefined;
  }
}
export function parseDashboardStreamMessage(
  value: unknown,
): DashboardStreamMessage {
  const message = parseSchema(
    DashboardStreamMessageSchema,
    value,
    'dashboard stream message',
  );
  if ('event' in message) validateDashboardEventEnvelopeCapabilities(message);
  else validateBrowserSnapshotCapabilities(message.snapshot);
  return message;
}
export function tryParseDashboardStreamMessage(
  value: unknown,
): DashboardStreamMessage | undefined {
  try {
    return parseDashboardStreamMessage(value);
  } catch {
    return undefined;
  }
}
export function parseBrowserSnapshot(value: unknown): BrowserSnapshot {
  const snapshot = parseSchema(
    BrowserSnapshotSchema,
    value,
    'browser snapshot',
  );
  validateBrowserSnapshotCapabilities(snapshot);
  return snapshot;
}
export function tryParseBrowserSnapshot(
  value: unknown,
): BrowserSnapshot | undefined {
  try {
    return parseBrowserSnapshot(value);
  } catch {
    return undefined;
  }
}
export function parseDashboardMessage(value: unknown): DashboardMessage {
  const message = parseSchema(
    DashboardMessageSchema,
    value,
    'dashboard message',
  );
  if (message.type === 'snapshot')
    validateBrowserSnapshotCapabilities(message.snapshot);
  else {
    validateBridgeEventCapabilities(message.event);
    if (message.snapshot) validateBrowserSnapshotCapabilities(message.snapshot);
  }
  return message;
}
export function tryParseDashboardMessage(
  value: unknown,
): DashboardMessage | undefined {
  try {
    return parseDashboardMessage(value);
  } catch {
    return undefined;
  }
}
export function parseSessionApiResponse(value: unknown): SessionApiResponse {
  return parseSchema(SessionApiResponseSchema, value, 'session API response');
}
export function tryParseSessionApiResponse(
  value: unknown,
): SessionApiResponse | undefined {
  return tryParseSchema(SessionApiResponseSchema, value);
}
