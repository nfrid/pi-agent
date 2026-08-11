# Extension contributions

Pi extensions expose dashboard behavior through the schema-first
`@pi-dashboard/extension-contributions` package. A contribution is data plus a
host adapter; it is not a React component or a slash command.

## Adding a contribution

1. Add a versioned `ExtensionManifest` next to the extension. Give every action,
   renderer, inspector, and interaction a globally stable ID (`extension.id` is
   a useful prefix). IDs must be unique within their dispatched category
   (actions, renderers, inspectors, or interactions); the same ID in different
   categories is intentional and allowed because dispatch namespaces are
   separate.
2. Define every action input and every renderer view model with TypeBox. Set
   `availability.requires` to capability IDs and set `idempotent: true` only
   when replaying the same command is harmless.
3. Export the manifest and build a runtime summary with
   `createRuntimeCapabilitySnapshot`. Register the contribution through
   `registerExtensionCapability` (session-scoped via
   `extensions/shared/runtime/capability-registry.ts`) so remote-control can
   aggregate manifests, capability summaries, and action handlers without
   hard-importing peer extensions. Old runtimes may omit capability summaries.
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

## Installed Pi host-API shims

These shims cover host APIs still missing as of Pi 0.84.1.

* `extensions/ask-user/dialogs.ts` is the bounded RPC `select`/`input`
  fallback. It loses previews because Pi RPC has no `custom()` payload;
  remove it when Pi RPC exposes rich/custom dialog payloads. The separate
  headless omission is removed only when Pi exposes a headless interaction API.
  Broker answer and cancel do not require a shim and retain session scope,
  timeout, and single-winner resolution.
* `extensions/activity-groups/shim.ts` is used only after its exact installed
  component-method canary passes because Pi has no public
  `registerToolSequenceRenderer`. Remove the prototype patch and its canary
  when that public hook and the sequence renderer contract ship; keep the
  semantic `activity-groups.set` adapter.
* A command-context-only activity toggle is bridged by the bounded semantic
  action handler in `extensions/activity-groups/actions.ts`. Remove only when
  Pi exposes a safe extension-action dispatcher, not merely when a new slash
  command is added.

These removal conditions are intentionally exact: changing a private Pi class
shape must make a shim fail closed, never expand its reach.

## Skill envelopes in the local TUI

Pi 0.84.1's interactive mode has a native renderer for the canonical skill
message envelope (`<skill name="..." location="...">...</skill>`). It renders a
collapsed `[skill] name` event and the following user request separately; its
expand action renders the skill instructions. The original user message is
still retained for the model and session history. Do not replace this with a
`registerMessageRenderer` call: that API is only for custom messages, not
ordinary user messages.

`extensions/skill-message-rendering` uses the supported
`registerMarkdownTransformer` hook only as a fallback for messages containing
multiple envelopes or surrounding text, which the native parser does not
recognize as one canonical invocation. The transformer is display-only and
leaves canonical single envelopes untouched so native expansion is preserved.
The hook has no `expanded` argument and cannot add the envelope's exact
`location` attribute to Pi's native expanded component. That is a host API
limitation: do not monkey-patch `UserMessageComponent` or
`SkillInvocationMessageComponent` to work around it. The raw location and
instructions remain in the unmodified session message; a future public skill
renderer hook can replace this fallback and expose both fields directly.
