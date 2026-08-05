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
import { type Static, Type } from 'typebox';
import { MAX_ID, MAX_PATH, MAX_TEXT } from './limits.js';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 512 * 1024;
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
