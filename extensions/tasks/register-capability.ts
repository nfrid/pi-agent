import { registerExtensionCapability } from '../shared/runtime/capability-registry';
import { tasksCapabilitySnapshot, tasksManifest } from './contribution';

let registered = false;

/** Publish tasks contribution contracts into the capability registry. */
export function registerTasksCapability(): void {
  if (registered) return;
  registered = true;
  registerExtensionCapability({
    id: tasksManifest.id,
    manifest: tasksManifest,
    capabilities: tasksCapabilitySnapshot.capabilities,
  });
}
