import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  type RendererDescriptor,
} from '@pi-dashboard/extension-contributions';
import { Type } from 'typebox';

export const ACTIVITY_GROUPS_CAPABILITY_ID = 'activity-groups';
export const ACTIVITY_GROUPS_RENDERER_ID = 'activity-groups.activity';
export const ACTIVITY_GROUPS_ACTION_ID = 'activity-groups.set';

export const ActivityGroupsActionInputSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    expanded: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
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
  },
  { additionalProperties: false },
);

export const ActivityGroupsViewModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
    kind: Type.Union([
      Type.Literal('inspect'),
      Type.Literal('mutate'),
      Type.Literal('validate'),
      Type.Literal('execute'),
      Type.Literal('mixed'),
    ]),
    title: Type.String({ minLength: 1, maxLength: 1000 }),
    status: Type.Union([
      Type.Literal('live'),
      Type.Literal('preparing'),
      Type.Literal('complete'),
      Type.Literal('failed'),
    ]),
    expanded: Type.Boolean(),
    toolCount: Type.Integer({ minimum: 0 }),
    tools: Type.Readonly(Type.Array(ActivityToolSchema, { maxItems: 128 })),
  },
  { additionalProperties: false },
);

export const activityGroupsRenderer: RendererDescriptor = {
  id: ACTIVITY_GROUPS_RENDERER_ID,
  mode: 'activity',
  inputSchema: ActivityGroupsViewModelSchema,
  title: 'Activity group',
  summary: 'A shared semantic projection of a model work phase.',
};

export const activityGroupsManifest: ExtensionManifest = {
  id: 'activity-groups',
  version: '1',
  title: 'Activity groups',
  actions: [
    {
      id: ACTIVITY_GROUPS_ACTION_ID,
      title: 'Set activity groups',
      inputSchema: ActivityGroupsActionInputSchema,
      availability: { requires: [ACTIVITY_GROUPS_CAPABILITY_ID] },
      idempotent: true,
    },
  ],
  renderers: [activityGroupsRenderer],
};

export const activityGroupsCapabilitySnapshot = createRuntimeCapabilitySnapshot(
  [activityGroupsManifest],
  [
    {
      id: ACTIVITY_GROUPS_CAPABILITY_ID,
      version: '1',
      available: true,
      summary: 'Shared activity grouping projection and expansion state.',
    },
  ],
);
