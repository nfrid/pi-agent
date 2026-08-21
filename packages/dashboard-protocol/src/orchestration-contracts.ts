import { type Static, Type } from 'typebox';
import { MAX_ID, MAX_PATH, MAX_TEXT } from './limits.js';

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: MAX_ID,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$',
});
const PathSchema = Type.String({ minLength: 1, maxLength: MAX_PATH });
const TimestampSchema = Type.Number();

/** Bounded provider/model identity used by durable runs and project defaults. */
export const ModelSelectionSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 200 }),
    model: Type.String({ minLength: 1, maxLength: 300 }),
    thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);
export type ModelSelection = Static<typeof ModelSelectionSchema>;

export const ProjectStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('archived'),
]);
export type ProjectStatus = Static<typeof ProjectStatusSchema>;

export const CheckoutKindSchema = Type.Union([
  Type.Literal('main'),
  Type.Literal('worktree'),
  Type.Literal('external'),
]);
export type CheckoutKind = Static<typeof CheckoutKindSchema>;
export const CheckoutStatusSchema = Type.Union([
  Type.Literal('preparing'),
  Type.Literal('ready'),
  Type.Literal('dirty'),
  Type.Literal('merging'),
  Type.Literal('retired'),
  Type.Literal('failed'),
]);
export type CheckoutStatus = Static<typeof CheckoutStatusSchema>;

/**
 * Execution status is deliberately independent from archive visibility. The
 * `archived` literal is retained only so old stored rows and old consumers can
 * still be decoded; new lifecycle writes leave this projection unchanged.
 */
export const ThreadStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('queued'),
  Type.Literal('active'),
  Type.Literal('needs-input'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('stopped'),
  Type.Literal('archived'),
]);
export type ThreadStatus = Static<typeof ThreadStatusSchema>;

export const ThreadLifecycleEventTypeSchema = Type.Union([
  Type.Literal('legacy.snapshot'),
  Type.Literal('thread.archive'),
  Type.Literal('thread.restore'),
  Type.Literal('thread.pin'),
  Type.Literal('thread.unpin'),
  Type.Literal('thread.settle'),
  Type.Literal('thread.unsettle'),
]);
export type ThreadLifecycleEventType = Static<
  typeof ThreadLifecycleEventTypeSchema
>;

export const ThreadLifecycleActorSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('migration'),
]);
export type ThreadLifecycleActor = Static<typeof ThreadLifecycleActorSchema>;
export const ThreadLifecycleReasonSchema = Type.Union([
  Type.Literal('user-command'),
  Type.Literal('legacy-snapshot'),
]);
export type ThreadLifecycleReason = Static<typeof ThreadLifecycleReasonSchema>;

/** Ordered durable lifecycle history. This is an internal projection contract. */
export const ThreadLifecycleEventSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    threadId: IdentifierSchema,
    type: ThreadLifecycleEventTypeSchema,
    commandId: Type.Optional(IdentifierSchema),
    actor: ThreadLifecycleActorSchema,
    reason: ThreadLifecycleReasonSchema,
    data: Type.Unknown(),
    occurredAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type ThreadLifecycleEvent = Static<typeof ThreadLifecycleEventSchema>;

export const RunStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('preparing'),
  Type.Literal('starting'),
  Type.Literal('running'),
  Type.Literal('waiting'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('interrupted'),
]);
export type RunStatus = Static<typeof RunStatusSchema>;

/** Read runs may share a checkout; write runs exclusively own it while active. */
export const RunModeSchema = Type.Union([
  Type.Literal('read'),
  Type.Literal('write'),
]);
export type RunMode = Static<typeof RunModeSchema>;

export const RuntimeProviderSchema = Type.Literal('extension-bridge');
export type RuntimeProvider = Static<typeof RuntimeProviderSchema>;

export const ProjectSchema = Type.Object(
  {
    id: IdentifierSchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    /** Canonical local repository root used to identify this project. */
    rootPath: PathSchema,
    /** Stable VCS identity, normally derived from the repository common dir. */
    repositoryIdentity: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_PATH }),
    ),
    defaultBaseBranch: Type.Optional(
      Type.String({ minLength: 1, maxLength: 512 }),
    ),
    defaultModel: Type.Optional(ModelSelectionSchema),
    defaultIsolation: Type.Union([
      Type.Literal('worktree'),
      Type.Literal('main'),
    ]),
    maxParallelRuns: Type.Integer({ minimum: 1, maximum: 1024 }),
    status: ProjectStatusSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type Project = Static<typeof ProjectSchema>;
export const ProjectSummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    rootPath: PathSchema,
    /** Default checkout isolation used by the new-thread form. */
    defaultIsolation: Type.Optional(
      Type.Union([Type.Literal('worktree'), Type.Literal('main')]),
    ),
    status: ProjectStatusSchema,
    maxParallelRuns: Type.Integer({ minimum: 1, maximum: 1024 }),
    activeRunCount: Type.Integer({ minimum: 0 }),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type ProjectSummary = Static<typeof ProjectSummarySchema>;

export const CheckoutSchema = Type.Object(
  {
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    kind: CheckoutKindSchema,
    path: PathSchema,
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    baseSha: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    status: CheckoutStatusSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type Checkout = Static<typeof CheckoutSchema>;
export const CheckoutSummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    kind: CheckoutKindSchema,
    path: PathSchema,
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    status: CheckoutStatusSchema,
    activeRunId: Type.Optional(IdentifierSchema),
    /** Number of changed paths persisted in the worktree record, when known. */
    changedFileCount: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type CheckoutSummary = Static<typeof CheckoutSummarySchema>;

export const ThreadSchema = Type.Object(
  {
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    checkoutId: Type.Optional(IdentifierSchema),
    status: ThreadStatusSchema,
    /** Independent visibility state; execution status is never replaced by archive. */
    archivedAt: Type.Optional(TimestampSchema),
    settledAt: Type.Optional(TimestampSchema),
    /** Execution projection remembered while archived; omitted for visible threads. */
    preArchiveStatus: Type.Optional(ThreadStatusSchema),
    pinnedAt: Type.Optional(TimestampSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type Thread = Static<typeof ThreadSchema>;
export const ThreadSummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    checkoutId: Type.Optional(IdentifierSchema),
    status: ThreadStatusSchema,
    pinnedAt: Type.Optional(TimestampSchema),
    activeRunId: Type.Optional(IdentifierSchema),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type ThreadSummary = Static<typeof ThreadSummarySchema>;

/** Exact persisted identity join for an ordinary Pi session. */
export const SessionThreadLinkSchema = Type.Object(
  {
    sessionId: IdentifierSchema,
    threadId: IdentifierSchema,
    archivedAt: Type.Optional(TimestampSchema),
    settledAt: Type.Optional(TimestampSchema),
    pinnedAt: Type.Optional(TimestampSchema),
    activeRunId: Type.Optional(IdentifierSchema),
  },
  { additionalProperties: false },
);
export type SessionThreadLink = Static<typeof SessionThreadLinkSchema>;
export const SessionThreadLinksSchema = Type.Array(SessionThreadLinkSchema, {
  maxItems: 4096,
});
export type SessionThreadLinks = Static<typeof SessionThreadLinksSchema>;

/** Result returned by the repository/service lifecycle boundary. */
export type ThreadLifecycleCommandResult = {
  readonly thread: Thread;
  readonly event: ThreadLifecycleEvent;
  readonly receipt?: CommandReceipt;
};

export const RunSchema = Type.Object(
  {
    id: IdentifierSchema,
    threadId: IdentifierSchema,
    checkoutId: IdentifierSchema,
    attempt: Type.Integer({ minimum: 1 }),
    /** Previous attempt in the same thread, if this run is a retry/resume. */
    parentRunId: Type.Optional(IdentifierSchema),
    mode: RunModeSchema,
    runtimeProvider: RuntimeProviderSchema,
    runtimeId: Type.Optional(IdentifierSchema),
    piSessionId: Type.Optional(IdentifierSchema),
    /** Complete user intent; never replace this with a rendered transcript. */
    initialPrompt: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    model: Type.Optional(ModelSelectionSchema),
    status: RunStatusSchema,
    createdAt: TimestampSchema,
    startedAt: Type.Optional(TimestampSchema),
    finishedAt: Type.Optional(TimestampSchema),
    error: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT })),
  },
  { additionalProperties: false },
);
export type Run = Static<typeof RunSchema>;
export const RunSummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    threadId: IdentifierSchema,
    checkoutId: IdentifierSchema,
    attempt: Type.Integer({ minimum: 1 }),
    parentRunId: Type.Optional(IdentifierSchema),
    mode: RunModeSchema,
    runtimeProvider: RuntimeProviderSchema,
    runtimeId: Type.Optional(IdentifierSchema),
    piSessionId: Type.Optional(IdentifierSchema),
    model: Type.Optional(ModelSelectionSchema),
    status: RunStatusSchema,
    createdAt: TimestampSchema,
    startedAt: Type.Optional(TimestampSchema),
    finishedAt: Type.Optional(TimestampSchema),
    error: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT })),
  },
  { additionalProperties: false },
);
export type RunSummary = Static<typeof RunSummarySchema>;

export const CommandReceiptSchema = Type.Object(
  {
    idempotencyKey: IdentifierSchema,
    commandType: Type.String({ minLength: 1, maxLength: 128 }),
    resourceType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    resourceId: Type.Optional(IdentifierSchema),
    /** Runtime command receipts share this table with orchestration receipts. */
    runtimeId: Type.Optional(IdentifierSchema),
    /** Fixed-size digest used to reject ID reuse with different intent. */
    commandFingerprint: Type.Optional(
      Type.String({
        minLength: 64,
        maxLength: 64,
        pattern: '^[0-9a-f]{64}$',
      }),
    ),
    result: Type.Unknown(),
    createdAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type CommandReceipt = Static<typeof CommandReceiptSchema>;

export const ThreadLifecycleCommandResultSchema = Type.Object(
  {
    thread: ThreadSchema,
    event: ThreadLifecycleEventSchema,
    receipt: Type.Optional(CommandReceiptSchema),
  },
  { additionalProperties: false },
);

/** A runtime binding is a shell concern, not a transcript or browser entity. */
export const OrchestrationRuntimeSchema = Type.Object(
  {
    runtimeId: IdentifierSchema,
    piSessionId: IdentifierSchema,
    runId: Type.Optional(IdentifierSchema),
    status: Type.Union([
      Type.Literal('starting'),
      Type.Literal('running'),
      Type.Literal('stopped'),
      Type.Literal('failed'),
    ]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type OrchestrationRuntime = Static<typeof OrchestrationRuntimeSchema>;

/** Provider-neutral runtime lifecycle contracts retained for existing adapters. */
export interface RuntimeLocation {
  /** Provider-defined, opaque identity persisted for daemon restart recovery. */
  readonly id: string;
  readonly displayTarget?: string;
}

export interface RuntimeBinding {
  readonly runtimeId: string;
  readonly location?: RuntimeLocation;
  readonly processId?: number;
}

export interface RuntimeStartInput {
  readonly runtimeId: string;
  /** Provider selection is dashboard-neutral; native Pi types stay in adapters. */
  readonly runtimeProvider?: RuntimeProvider;
  /** Existing Pi session identity for native provider attachment. */
  readonly sessionId?: string;
  /** Managed orchestration runs may restrict the Pi tool set. */
  readonly mode?: RunMode;
  readonly cwd: string;
  readonly name?: string;
  readonly socketPath: string;
  readonly launchToken: string;
  readonly identityToken: string;
  readonly sessionFile?: string;
  readonly model?: {
    readonly provider: string;
    readonly model: string;
    readonly thinking?: string;
  };
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly sessionId?: string;
    readonly active: boolean;
  };
}

export interface RuntimeAttachInput {
  readonly runtimeId: string;
  readonly location: RuntimeLocation;
}

export interface RuntimeCommand {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface RuntimeProviderEvent {
  readonly type: string;
  readonly runtimeId: string;
  readonly [key: string]: unknown;
}

export interface AgentRuntimeProvider {
  start(input: RuntimeStartInput): Promise<RuntimeBinding>;
  attach(input: RuntimeAttachInput): Promise<RuntimeBinding>;
  stop(binding: RuntimeBinding): Promise<void>;
  send(binding: RuntimeBinding, command: RuntimeCommand): Promise<void>;
  subscribe(
    binding: RuntimeBinding,
    listener: (event: RuntimeProviderEvent) => void,
  ): () => void;
}
