/** Canonical framework-free contracts for the dashboard's built-in surfaces. */
import { type Static, type TSchema, Type } from 'typebox';
import { DelegateUsageSchema } from './delegate-usage.js';
import type { RendererDescriptor } from './index.js';

export const ACTIVITY_GROUPS_RENDERER_ID = 'activity-groups.activity';

const ActivityToolArgsSchema = Type.Union([
  Type.String({ maxLength: 10_000 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  // Tool arguments are opaque provider data. Bound the top-level payload so a
  // renderer cannot receive an unbounded object or array from a transcript.
  Type.Array(Type.Unknown(), { maxItems: 128 }),
  Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown(), {
    maxProperties: 128,
  }),
]);
const ActivityToolSchema = Type.Object(
  {
    kind: Type.Literal('tool'),
    name: Type.String({ minLength: 1, maxLength: 512 }),
    args: Type.Optional(ActivityToolArgsSchema),
    status: Type.Optional(
      Type.Union([
        Type.Literal('pending'),
        Type.Literal('running'),
        Type.Literal('complete'),
        Type.Literal('success'),
        Type.Literal('error'),
      ]),
    ),
    isError: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ActivityGroupsViewModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
    phases: Type.Readonly(
      Type.Array(
        Type.Union([
          Type.Literal('inspect'),
          Type.Literal('mutate'),
          Type.Literal('validate'),
          Type.Literal('execute'),
          Type.Literal('coordinate'),
          Type.Literal('other'),
        ]),
        { maxItems: 128 },
      ),
    ),
    title: Type.String({ minLength: 1, maxLength: 1000 }),
    status: Type.Union([
      Type.Literal('live'),
      Type.Literal('preparing'),
      Type.Literal('settled'),
      Type.Literal('ended-error'),
    ]),
    expanded: Type.Boolean(),
    toolCount: Type.Integer({ minimum: 0 }),
    tools: Type.Readonly(Type.Array(ActivityToolSchema, { maxItems: 128 })),
  },
  { additionalProperties: false },
);
export type ActivityGroupsViewModel = Static<
  typeof ActivityGroupsViewModelSchema
>;

export const activityGroupsRenderer: RendererDescriptor = {
  id: ACTIVITY_GROUPS_RENDERER_ID,
  mode: 'activity',
  inputSchema: ActivityGroupsViewModelSchema,
  title: 'Activity group',
  summary: 'A shared semantic projection of a model work phase.',
};

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
export type DelegateRunState = Static<typeof DelegateRunStateSchema>;
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
export type DelegateWorkflowState = Static<typeof DelegateWorkflowStateSchema>;
const DelegateWakeStateSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('ready'),
  Type.Literal('queued'),
  Type.Literal('entered'),
  Type.Literal('cancelled'),
  Type.Literal('blocked'),
]);
export type DelegateWakeState = Static<typeof DelegateWakeStateSchema>;
const DelegateLifecycleReasonSchema = Type.Union([
  Type.Literal('user-cancellation'),
  Type.Literal('queued-cancellation'),
  Type.Literal('timeout'),
  Type.Literal('child-nonzero-exit'),
  Type.Literal('provider-runner-error'),
  Type.Literal('setup-failure'),
  Type.Literal('lifecycle-cleanup-failure'),
  Type.Literal('unknown'),
]);
export type DelegateLifecycleReason = Static<
  typeof DelegateLifecycleReasonSchema
>;
const DelegateLifecycleSchema = Type.Object(
  {
    reason: DelegateLifecycleReasonSchema,
    diagnostic: Type.Optional(Type.String({ maxLength: 65_536 })),
    diagnosticFile: Type.Optional(
      Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        size: Type.Integer({ minimum: 0 }),
      }),
    ),
    continuationUsable: Type.Boolean(),
    writableBranchRetained: Type.Boolean(),
    readOnlySnapshotRetained: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type DelegatePauseState = 'pausing' | 'paused';

const DelegateLiveInputEvidenceSchema = Type.Object(
  {
    identity: Type.String({ minLength: 1, maxLength: 80 }),
    kind: Type.Union([
      Type.Literal('report'),
      Type.Literal('handoff'),
      Type.Literal('branch'),
      Type.Literal('metadata'),
    ]),
    label: Type.String({ minLength: 1, maxLength: 120 }),
    content: Type.Optional(Type.String({ maxLength: 48 * 1024 })),
    branch: Type.Optional(
      Type.Object(
        {
          branch: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          worktreePath: Type.Optional(
            Type.String({ minLength: 1, maxLength: 4096 }),
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
const DelegateLiveDetailsSchema = Type.Object(
  {
    task: Type.Optional(Type.String({ maxLength: 32 * 1024 })),
    setup: Type.Optional(
      Type.Object(
        {
          cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
          isolation: Type.Optional(
            Type.Union([Type.Literal('shared'), Type.Literal('worktree')]),
          ),
          worktree: Type.Optional(
            Type.Object(
              {
                branch: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 512 }),
                ),
                worktreePath: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 4096 }),
                ),
                repositoryRoot: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 4096 }),
                ),
                baseHead: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 256 }),
                ),
                baseRef: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 512 }),
                ),
                workBase: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 256 }),
                ),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    runConfig: Type.Optional(
      Type.Object(
        {
          scope: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
              maxItems: 128,
            }),
          ),
          after: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
              maxItems: 32,
            }),
          ),
          inputs: Type.Optional(
            Type.Array(DelegateLiveInputEvidenceSchema, { maxItems: 8 }),
          ),
          parentContextNote: Type.Optional(
            Type.String({ maxLength: 64 * 1024 }),
          ),
          refreshSource: Type.Optional(
            Type.Union([Type.Literal('wip'), Type.Literal('head')]),
          ),
          warnings: Type.Optional(
            Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    renderedPrompt: Type.Optional(Type.String({ maxLength: 640 * 1024 })),
    truncated: Type.Boolean(),
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

const DelegateWorkflowInputSchema = Type.Object(
  {
    node: Type.String({ minLength: 1, maxLength: 80 }),
    identity: Type.String({ minLength: 1, maxLength: 80 }),
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
const DelegateWorkflowStatusSchema = Type.Object(
  {
    /** Missing only for legacy live workflow records. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    logicalId: Type.String({ minLength: 1, maxLength: 64 }),
    attempt: Type.Integer({ minimum: 1 }),
    identity: Type.String({ minLength: 1, maxLength: 80 }),
    state: DelegateWorkflowStateSchema,
    dependencies: Type.Readonly(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
        maxItems: 32,
      }),
    ),
    inputs: Type.Optional(
      Type.Readonly(Type.Array(DelegateWorkflowInputSchema, { maxItems: 4 })),
    ),
    waitingFor: Type.Optional(
      Type.Readonly(
        Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
          maxItems: 32,
        }),
      ),
    ),
    reason: Type.Optional(Type.String({ maxLength: 256 })),
    route: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    createdAt: Type.Number(),
    scheduledAt: Type.Number(),
    queuedAt: Type.Optional(Type.Number()),
    startedAt: Type.Optional(Type.Number()),
    settledAt: Type.Optional(Type.Number()),
    branchAvailable: Type.Optional(Type.Boolean()),
    snapshotAvailable: Type.Optional(Type.Boolean()),
    deliveredToParent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const DelegateWakeStatusSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    state: DelegateWakeStateSchema,
    references: Type.Readonly(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
        maxItems: 32,
      }),
    ),
    waitingFor: Type.Optional(
      Type.Readonly(
        Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
          maxItems: 32,
        }),
      ),
    ),
    createdAt: Type.Number(),
    readyAt: Type.Optional(Type.Number()),
    queuedAt: Type.Optional(Type.Number()),
    enteredAt: Type.Optional(Type.Number()),
    cancelledAt: Type.Optional(Type.Number()),
    blockedAt: Type.Optional(Type.Number()),
    reason: Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: false },
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
    runId: Type.String({ minLength: 1, maxLength: 256 }),
    /** Missing only for legacy delegate records. */
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    lineageId: Type.String({ minLength: 1, maxLength: 256 }),
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
    usage: Type.Optional(DelegateUsageSchema),
    capabilities: Type.Optional(
      Type.Readonly(
        Type.Array(Type.Literal('web'), { maxItems: 1, uniqueItems: true }),
      ),
    ),
    /** Immutable workspace mode; absent only on legacy live records. */
    isolation: Type.Optional(
      Type.Union([Type.Literal('shared'), Type.Literal('worktree')]),
    ),
    details: Type.Optional(DelegateLiveDetailsSchema),
    pauseState: Type.Optional(
      Type.Union([Type.Literal('pausing'), Type.Literal('paused')]),
    ),
    pausedAt: Type.Optional(Type.Number({ minimum: 0 })),
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
    lifecycle: Type.Optional(DelegateLifecycleSchema),
    workflow: Type.Optional(DelegateWorkflowStatusSchema),
  },
  { additionalProperties: false },
);

export const DelegateStatusViewModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    statuses: Type.Readonly(Type.Array(DelegateStatusSchema, { maxItems: 64 })),
    /** Active branch wake metadata only; payloads and handoffs are excluded. */
    wakes: Type.Optional(
      Type.Readonly(Type.Array(DelegateWakeStatusSchema, { maxItems: 256 })),
    ),
  },
  { additionalProperties: false },
);
export type DelegateActivity = Static<typeof DelegateActivitySchema>;
export type DelegateTranscriptEntry = Static<
  typeof DelegateTranscriptEntrySchema
>;
export type DelegateStatus = Static<typeof DelegateStatusSchema>;
export type DelegateWorkflowStatus = Static<
  typeof DelegateWorkflowStatusSchema
>;
export type DelegateWakeStatus = Static<typeof DelegateWakeStatusSchema>;
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

export const CONTINUE_ACTION_ID = 'runtime.continue';
export const PAUSE_RENDERER_ID = 'runtime.pause-status';
export const PAUSE_SURFACE_ID = 'runtime.pause-status';

export const PauseStatusViewModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    phase: Type.Union([Type.Literal('pausing'), Type.Literal('paused')]),
    delegateCount: Type.Integer({ minimum: 0, maximum: 20 }),
    pausedAt: Type.Optional(Type.Number({ minimum: 0 })),
    label: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type PauseStatusViewModel = Static<typeof PauseStatusViewModelSchema>;

export const pauseStatusRenderer: RendererDescriptor = {
  id: PAUSE_RENDERER_ID,
  mode: 'generic',
  inputSchema: PauseStatusViewModelSchema,
  title: 'Pause status',
  summary: 'Whether this runtime is pausing or paused.',
};

export const TASKS_RENDERER_ID = 'tasks.current';
export const TASKS_SURFACE_ID = 'tasks.current';

const TaskStatusSchema = Type.Union([
  Type.Literal('todo'),
  Type.Literal('doing'),
  Type.Literal('blocked'),
  Type.Literal('done'),
  Type.Literal('dropped'),
]);
const TaskPrioritySchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('normal'),
  Type.Literal('high'),
  Type.Literal('urgent'),
]);
export const TaskSurfaceTaskSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    text: Type.String({ maxLength: 4_000 }),
    status: TaskStatusSchema,
    dependsOn: Type.Readonly(
      Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        maxItems: 64,
      }),
    ),
    priority: Type.Optional(TaskPrioritySchema),
    notes: Type.Optional(Type.String({ maxLength: 10_000 })),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
);
const TaskStatsSchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    active: Type.Integer({ minimum: 0 }),
    done: Type.Integer({ minimum: 0 }),
    blocked: Type.Integer({ minimum: 0 }),
    ready: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export const TaskStateViewModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    tasks: Type.Readonly(Type.Array(TaskSurfaceTaskSchema, { maxItems: 128 })),
    stats: TaskStatsSchema,
  },
  { additionalProperties: false },
);
export type TaskSurfaceTask = Static<typeof TaskSurfaceTaskSchema>;
export type TaskStateViewModel = Static<typeof TaskStateViewModelSchema>;

export const tasksRenderer: RendererDescriptor = {
  id: TASKS_RENDERER_ID,
  mode: 'inspector',
  inputSchema: TaskStateViewModelSchema,
  title: 'Tasks',
  summary: 'The current bounded task state and dependency summary.',
};

export const SETTLED_BACKGROUND_RENDERER_ID = 'runtime.settled-background';
export const SETTLED_BACKGROUND_SURFACE_ID = 'runtime.settled-background';

export const SettledBackgroundViewModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    count: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type SettledBackgroundViewModel = Static<
  typeof SettledBackgroundViewModelSchema
>;
