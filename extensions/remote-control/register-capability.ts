import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { asCapabilityActionHost } from '../shared/runtime/capability-action-host';
import { registerExtensionCapability } from '../shared/runtime/capability-registry';
import {
  RUNTIME_ABORT_ACTION_ID,
  RUNTIME_SHUTDOWN_ACTION_ID,
  remoteControlCapabilitySnapshot,
  remoteControlManifest,
  SESSION_COMPACT_ACTION_ID,
} from './contribution';

let registered = false;

/** Publish remote-control contribution contracts into the capability registry. */
export function registerRemoteControlCapability(): void {
  if (registered) return;
  registered = true;
  registerExtensionCapability({
    id: remoteControlManifest.id,
    manifest: remoteControlManifest,
    capabilities: remoteControlCapabilitySnapshot.capabilities,
    actionHandlers: {
      [SESSION_COMPACT_ACTION_ID]: async (invocation, hostContext) => {
        const host = asCapabilityActionHost(hostContext);
        if (!host)
          throw Object.assign(
            new Error('Remote-control host context is missing.'),
            { code: 'unavailable-action' },
          );
        const input = invocation.input as { customInstructions?: string };
        await host.ctx.compact({
          customInstructions: input.customInstructions || undefined,
        });
        return { accepted: true, actionId: invocation.actionId };
      },
      [RUNTIME_ABORT_ACTION_ID]: (_invocation, hostContext) => {
        const host = asCapabilityActionHost(hostContext);
        if (!host)
          throw Object.assign(
            new Error('Remote-control host context is missing.'),
            { code: 'unavailable-action' },
          );
        host.ctx.abort();
        return { accepted: true, actionId: RUNTIME_ABORT_ACTION_ID };
      },
      [RUNTIME_SHUTDOWN_ACTION_ID]: (_invocation, hostContext) => {
        const host = asCapabilityActionHost(hostContext);
        if (!host)
          throw Object.assign(
            new Error('Remote-control host context is missing.'),
            { code: 'unavailable-action' },
          );
        host.ctx.shutdown();
        return { accepted: true, actionId: RUNTIME_SHUTDOWN_ACTION_ID };
      },
    },
  });
}

/** Convenience cast helpers retained for typed handler tests. */
export type RemoteControlActionHost = {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
};
