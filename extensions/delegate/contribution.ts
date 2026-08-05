import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  type RendererDescriptor,
} from '@pi-dashboard/extension-contributions';
import { Type } from 'typebox';

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
