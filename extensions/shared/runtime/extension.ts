/**
 * The registration contract every extension entry point follows.
 *
 * The host may invoke an extension's default export more than once for the same
 * `ExtensionAPI` — reloads and nested registration paths both do it — and a
 * second run would register duplicate tools, commands, and event handlers. Every
 * extension had independently pasted the same WeakSet guard to prevent that.
 *
 * The guard is per-extension, not global: two different extensions registering
 * against the same `pi` must both run.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export type ExtensionSetup = (pi: ExtensionAPI) => void;

/**
 * Wrap an extension's setup so it runs at most once per `ExtensionAPI`.
 *
 * ```ts
 * export default defineExtension('tasks', (pi) => {
 *   pi.registerTool(…);
 * });
 * ```
 */
export function defineExtension(
  name: string,
  setup: ExtensionSetup,
): ExtensionSetup {
  const registered = new WeakSet<object>();
  const guarded: ExtensionSetup = (pi) => {
    if (registered.has(pi)) return;
    registered.add(pi);
    setup(pi);
  };
  // Preserve a useful name for stack traces and debugging.
  Object.defineProperty(guarded, 'name', { value: name, configurable: true });
  return guarded;
}
