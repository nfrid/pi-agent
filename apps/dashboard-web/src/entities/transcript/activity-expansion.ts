import { dashboardHttpClient } from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';

function invokeActivityExpansion(
  runtime: RuntimeSnapshot | undefined,
  expanded: boolean,
): void {
  const actionId = 'activity-groups.set';
  const advertised = runtime?.capabilities?.manifests.some((manifest) =>
    manifest.actions.some((action) => action.id === actionId),
  );
  if (!runtime || !advertised || runtime.online === false) return;
  void dashboardHttpClient
    .invokeAction(runtime.runtimeId, actionId, { expanded })
    .catch(() => undefined);
}

export { invokeActivityExpansion };
