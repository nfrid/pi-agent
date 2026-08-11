import { registerExtensionCapability } from '../shared/runtime/capability-registry';
import { delegateCapabilitySnapshot, delegateManifest } from './contribution';

let registered = false;

/** Publish delegate contribution contracts into the capability registry. */
export function registerDelegateCapability(): void {
  if (registered) return;
  registered = true;
  registerExtensionCapability({
    id: delegateManifest.id,
    manifest: delegateManifest,
    capabilities: delegateCapabilitySnapshot.capabilities,
  });
}
