import {
  activityGroupsRenderer,
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
} from '@pi-dashboard/extension-contributions';
import { Type } from 'typebox';

export type { ActivityGroupsViewModel } from '@pi-dashboard/extension-contributions';
export {
  ACTIVITY_GROUPS_RENDERER_ID,
  ActivityGroupsViewModelSchema,
  activityGroupsRenderer,
} from '@pi-dashboard/extension-contributions';

export const ACTIVITY_GROUPS_CAPABILITY_ID = 'activity-groups';
export const ACTIVITY_GROUPS_ACTION_ID = 'activity-groups.set';

export const ActivityGroupsActionInputSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    expanded: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

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
