# Extension contributions

Pi extensions expose dashboard behavior through the schema-first
`@pi-dashboard/extension-contributions` package. A contribution is data plus a
host adapter; it is not a React component or a slash command.

## Adding a contribution

1. Add a versioned `ExtensionManifest` next to the extension. Give every action,
   renderer, inspector, and interaction a globally stable ID (`extension.id` is
   a useful prefix).
2. Define every action input and every renderer view model with TypeBox. Set
   `availability.requires` to capability IDs and set `idempotent: true` only
   when replaying the same command is harmless.
3. Export the manifest and build a runtime summary with
   `createRuntimeCapabilitySnapshot`. The remote adapter advertises summaries
   in `runtime.hello` and in the runtime snapshot; old runtimes may omit them.
4. Add a semantic adapter handler in the extension/remote adapter. Invoke the
   action envelope (`{ id, type: "action.invoke", actionId, input }`), never a
   browser slash-command string. Validate input again at the Pi boundary.
5. Add a dashboard renderer as an explicit import in
   `apps/dashboard-web/src/renderer-registry.tsx`. Register its descriptor and
   local adapter in the static list. Duplicate IDs and invalid schemas fail at
   registry construction; unknown IDs use the generic JSON fallback. Runtime
   JavaScript, filesystem discovery, `eval`, and arbitrary frontend code are
   deliberately unsupported.
6. Add contract tests for malformed fields, action input/availability,
   duplicate command IDs, absent capability snapshots, and unknown renderers.

Unknown fields are rejected by contribution parsers. Missing capability data is
not an error: selectors return no advertised actions and the dashboard uses
legacy protocol-v1 behavior only where that existing API requires it. Unknown
capability/action/renderer IDs never execute or load code.

## Installed Pi 0.82.1 shims

* `extensions/ask-user/dialogs.ts` is the bounded RPC `select`/`input`
  fallback. It loses previews because Pi 0.82.1 RPC has no `custom()` payload;
  remove it when Pi RPC exposes rich/custom dialog payloads. The separate
  headless omission is removed only when Pi exposes a headless interaction API.
  Broker answer and cancel do not require a shim and retain session scope,
  timeout, and single-winner resolution.
* `extensions/activity-groups/shim.ts` is used only after its exact installed
  component-method canary passes because Pi 0.82.1 has no public
  `registerToolSequenceRenderer`. Remove the prototype patch and its canary
  when that public hook and the sequence renderer contract ship; keep the
  semantic `activity-groups.set` adapter.
* A command-context-only activity toggle is bridged by the bounded semantic
  action handler in `extensions/activity-groups/actions.ts`. Remove only when
  Pi exposes a safe extension-action dispatcher, not merely when a new slash
  command is added.

These removal conditions are intentionally exact: changing a private Pi class
shape must make a shim fail closed, never expand its reach.
