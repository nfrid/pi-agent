import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadIsolation, scrubStaleIsolationCredentials } from './isolation';
import { registerDelegatePatchCommand } from './patch-command';
import { pruneDelegateSessions } from './session';
import { registerDelegateTool } from './tool';
import { delegateToolBoundary } from './tool-boundary';

const registered = new WeakSet<object>();

/** Stable registration facade; orchestration and broker commands have separate owners. */
export default function delegate(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);
  const isChild = process.env.PI_DELEGATE_CHILD === '1';

  if (isChild) {
    pi.on('tool_call', (event, ctx) => {
      const reason = delegateToolBoundary(event.toolName, event.input, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    });
    return;
  }

  scrubStaleIsolationCredentials();
  pi.on('session_start', (_event, ctx) => {
    pruneDelegateSessions({
      isIsolationRetained: (id) => Boolean(loadIsolation(id)),
    });
    registerDelegateTool(pi, ctx.cwd);
  });

  registerDelegatePatchCommand(pi);
}
