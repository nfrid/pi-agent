import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadIsolation, scrubStaleIsolationCredentials } from './isolation';
import { registerDelegatePatchCommand } from './patch-command';
import { pruneDelegateSessions } from './session';
import { registerDelegateTool } from './tool';

export {
  assertDistinctContinuationTokens,
  buildArtifactBackedHandoff,
  mergeDelegateRouteRequest,
  throwIfAllRunsFailed,
} from './supervision';

const registered = new WeakSet<object>();

/** Stable registration facade; orchestration and broker commands have separate owners. */
export default function delegate(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);
  scrubStaleIsolationCredentials();
  if (process.env.PI_DELEGATE_CHILD === '1') return;

  pi.on('session_start', () => {
    pruneDelegateSessions({
      isIsolationRetained: (id) => Boolean(loadIsolation(id)),
    });
  });

  registerDelegateTool(pi);
  registerDelegatePatchCommand(pi);
}
