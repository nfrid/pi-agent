import { asCapabilityActionHost } from '../shared/runtime/capability-action-host';
import { registerExtensionCapability } from '../shared/runtime/capability-registry';
import {
  CONTINUE_ACTION_ID,
  PAUSE_ACTION_ID,
  pauseCapabilitySnapshot,
  pauseManifest,
} from './contribution';
import { requestRuntimePause, resumeRuntimePause } from './operations';

let registered = false;

export function registerPauseCapability(): void {
  if (registered) return;
  registered = true;
  registerExtensionCapability({
    id: pauseManifest.id,
    manifest: pauseManifest,
    capabilities: pauseCapabilitySnapshot.capabilities,
    actionHandlers: {
      [PAUSE_ACTION_ID]: (invocation, hostContext) => {
        const host = asCapabilityActionHost(hostContext);
        if (!host)
          throw Object.assign(new Error('Pause host context is missing.'), {
            code: 'unavailable-action',
          });
        requestRuntimePause(host.pi, host.ctx);
        return { accepted: true, actionId: invocation.actionId };
      },
      [CONTINUE_ACTION_ID]: (invocation, hostContext) => {
        const host = asCapabilityActionHost(hostContext);
        if (!host)
          throw Object.assign(new Error('Pause host context is missing.'), {
            code: 'unavailable-action',
          });
        if (!resumeRuntimePause(host.pi, host.ctx))
          throw Object.assign(new Error('Runtime is not paused.'), {
            code: 'unavailable-action',
          });
        return { accepted: true, actionId: invocation.actionId };
      },
    },
  });
}
