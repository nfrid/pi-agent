import { registerExtensionCapability } from '../shared/runtime/capability-registry';
import { executeActivityGroupsAction } from './actions';
import {
  ACTIVITY_GROUPS_ACTION_ID,
  activityGroupsCapabilitySnapshot,
  activityGroupsManifest,
} from './contribution';

let registered = false;

/** Publish activity-groups contribution contracts into the capability registry. */
export function registerActivityGroupsCapability(): void {
  if (registered) return;
  registered = true;
  registerExtensionCapability({
    id: activityGroupsManifest.id,
    manifest: activityGroupsManifest,
    capabilities: activityGroupsCapabilitySnapshot.capabilities,
    actionHandlers: {
      [ACTIVITY_GROUPS_ACTION_ID]: (invocation) =>
        executeActivityGroupsAction(invocation.input),
    },
  });
}
