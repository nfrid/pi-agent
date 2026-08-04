import { parseActionInput } from '@pi-dashboard/extension-contributions';
import {
  ACTIVITY_GROUPS_ACTION_ID,
  activityGroupsManifest,
} from './contribution';

export interface ActivityGroupsActionState {
  enabled: boolean;
  expanded: boolean;
}

type Handler = (input: {
  enabled?: boolean;
  expanded?: boolean;
}) => Promise<ActivityGroupsActionState> | ActivityGroupsActionState;

let handler: Handler | undefined;

/** Installed by the TUI adapter; the remote adapter never patches Pi context. */
export function installActivityGroupsActionHandler(
  next: Handler | undefined,
): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
  };
}

export async function executeActivityGroupsAction(
  input: unknown,
): Promise<ActivityGroupsActionState> {
  const parsed = parseActionInput(
    activityGroupsManifest.actions[0] as { id: string; inputSchema: never },
    input,
  ) as { enabled?: boolean; expanded?: boolean };
  if (!handler)
    throw Object.assign(
      new Error('Activity group actions are unavailable in this Pi build.'),
      { code: 'unavailable-action' },
    );
  return handler(parsed);
}

export { ACTIVITY_GROUPS_ACTION_ID };
