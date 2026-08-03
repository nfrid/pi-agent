# HFM-20260730: Enable agent-requested runtime reload

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-07-30
- **Source reports:** [HF-20260729: Agent cannot reload extension runtime after updating it](../inbox/20260729T141648Z-agent-cannot-reload-extension-runtime.md)
- **Decision:** Unparked 2026-08-04 to consider a version-pinned, fail-closed runtime-context shim; implementation remains separately unapproved

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

After the harness changes an extension, the active Pi session continues using the extension instance loaded before the change. The agent can run static and unit checks but cannot prove that subsequent tool calls use the new runtime without user-triggered `/reload` or a replacement session.

Pi 0.82.1 documents a command/tool bridge in which a command calls `await ctx.reload(); return` and an LLM-callable tool queues that command as a follow-up user message. The installed runtime contradicts the example: extension-command dispatch is gated on prompt expansion, while `sendUserMessage()` explicitly disables prompt expansion. Enabling expansion alone would also execute the command immediately before follow-up queueing, potentially reloading during tool execution. The documented bridge therefore cannot provide a safe deferred reload on the pinned runtime.

No upstream change is available within this harness's maintenance boundary. A local solution must either use a narrowly contained private runtime seam or continue requiring user intervention.

## Baseline

One harness-maintenance session merged extension fixes and passed focused lifecycle tests, but intentionally deferred live verification because the current process retained the old extension runtime.

Installed Pi 0.82.1 exposes `ctx.reload()` only through `ExtensionCommandContext`. Its documentation requires reload to be terminal for the old command handler because code after `await ctx.reload()` still runs in the stale call frame. The documented `reload-runtime.ts` example queues a registered command with `pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" })`.

In the installed runtime:

- extension-command dispatch occurs only when `expandPromptTemplates` is true (`dist/core/agent-session.js`);
- `sendUserMessage()` invokes the prompt path with that option false;
- `ExtensionRunner.createContext()` creates tool and event contexts without `reload()`;
- `ExtensionRunner.createCommandContext()` adds `reload()` by delegating to the runner's bound `reloadHandler`; and
- the real reload handler performs the complete shutdown, resource reload, runtime rebuild, `session_start`, and resource-discovery lifecycle.

This leaves one narrow local seam: expose the already-bound reload handler to ordinary extension contexts through a guarded runtime prototype shim, then invoke it only after `agent_settled` has returned.

## Hypothesis

If the harness installs an exact-version, fail-closed shim that adds a hidden reload capability to `ExtensionRunner.createContext()`, and a tool defers that capability until after `agent_settled`, then the agent can request a complete same-process runtime reload without command text entering model context or reload occurring during tool execution.

This assumes Pi 0.82.1's private `ExtensionRunner` module is the same module instance used by the active session. Exact-version integration testing must prove that assumption before the tool is enabled.

## Guardrails

- Pin the shim to an explicitly supported Pi version and verified private-module structure or source hash; fail closed on any mismatch.
- Resolve the private runtime module relative to Pi's resolved public entrypoint. Do not hardcode Homebrew, npm-global, or other installation paths.
- Do not modify installed package files or persist a monkeypatch outside the current process.
- Patch only the narrow context-construction seam; do not alter prompt handling, command parsing, message dispatch, queue behavior, or `AgentSession.reload()`.
- Install the prototype patch exactly once using a collision-resistant global symbol, and expose reload on contexts through a non-enumerable collision-resistant symbol.
- The initiating tool may persist and report only that a request was queued, never that reload completed.
- Never invoke reload during tool execution or from the `agent_settled` handler's active call frame. Schedule it only after settlement dispatch returns.
- Treat invocation of the hidden reload capability as terminal for the old runtime. Do not use old `ctx`, `pi`, timers, or in-memory extension state afterward.
- Confirmation must be reconstructed by the new runtime instance after `session_start` with reason `reload`.
- Permit at most one queued or executing request. Repeated requests must coalesce or return the existing request status.
- Preserve session state and existing extension shutdown/startup semantics.
- Fail explicitly in unsupported Pi versions or modes; make no TUI-only assumptions.
- Keep a one-change rollback: disabling or removing the shim extension restores unmodified Pi behavior on the next process start.

## Options considered

1. **Keep manual `/reload` or start a new session:** Safest and already available, but preserves user intervention and blocks autonomous same-session verification.
2. **Use the documented command/tool bridge:** Small, but contradicted by the installed runtime. Literal command text can reach the model, while merely enabling command expansion risks immediate mid-tool reload.
3. **Patch `sendUserMessage()` or prompt dispatch:** Could force command recognition, but broadens behavior for user messages and still conflicts with the required deferred timing.
4. **Install a narrow `ExtensionRunner.createContext()` shim:** Reuses Pi's real bound reload handler, changes only capability exposure, and lets the harness enforce settlement timing. It depends on private runtime structure and therefore requires exact-version guards and real integration tests.
5. **Restart Pi through a supervisor:** Avoids private imports and fully refreshes the process, but requires a wrapper entrypoint, mode-specific restart/proxy behavior, CLI argument sanitization, and session resumption rather than a true reload lifecycle.
6. **Hot-load selected extension implementations behind stable proxies:** Uses public registration APIs but cannot generally refresh schemas, commands, handlers, skills, prompts, themes, or context files.
7. **Automate `/reload` through terminal keystrokes:** TUI-only, focus-dependent, difficult to confirm, and unsafe when multiple sessions or terminals are active.

## Recommendation

Implement option 4 as a small dedicated extension after separate approval.

At startup, the extension should resolve Pi's public package entrypoint, derive the private `core/extensions/runner.js` module, verify the exact supported version and expected implementation fingerprint, and idempotently wrap `ExtensionRunner.prototype.createContext`. The wrapper should preserve the original context unchanged except for one non-enumerable symbol method that calls the runner's existing active-instance assertion and bound reload handler.

Expose one collision-resistant tool with `request` and `status` actions. `request` should persist a request ID and requesting runtime generation, mark one reload pending, and return queued status. An `agent_settled` handler should schedule the symbol method with `setImmediate()` only after settlement dispatch returns. A newly constructed extension instance should confirm the request during `session_start` with reason `reload` by persisting its new runtime generation. `status` should reconstruct queued, completed, timed-out, unsupported, and failed states from persisted entries.

The implementation must not attempt compatibility when its private-runtime checks fail. Unsupported runtime should leave Pi unpatched and make the tool return an actionable error naming the detected and supported versions.

## Scope

- **In:** One dedicated local shim/reload extension; private module resolution relative to Pi's public entrypoint; exact-version and implementation-fingerprint checks; idempotent symbol-based context patch; deferred post-settlement invocation; persisted request and generation confirmation; duplicate prevention; focused and real-process integration tests.
- **Out:** Installed-package edits; prompt or message-dispatch patches; generalized access to command-context methods; automatic file watching; reload after every change; process supervision; terminal automation; compatibility guesses for unverified Pi versions; unrelated resource-loading changes.

## Acceptance criteria

- [ ] On the exact supported Pi version, the extension resolves and verifies the active private `ExtensionRunner` module without hardcoded installation paths.
- [ ] An unsupported version or implementation fingerprint leaves the prototype untouched and returns an actionable, fail-closed tool error.
- [ ] The shim patches `createContext()` exactly once and adds only one non-enumerable collision-resistant symbol capability.
- [ ] Existing context properties, getters, stale-instance checks, and command contexts behave unchanged.
- [ ] The initiating tool persists and reports queued status only; no literal slash command or synthetic user message enters model context.
- [ ] Reload begins only after the initiating tool, assistant work, queued continuations, and `agent_settled` dispatch complete.
- [ ] Reload executes exactly once and emits `session_shutdown` with reason `reload`, rebuilds extension/resources state, and emits `session_start` plus resource discovery with reason `reload`.
- [ ] A subsequent `status` call receives confirmation produced by the new runtime generation, including request ID, previous generation, and current generation.
- [ ] Repeated requests cannot cause overlapping or duplicate reloads.
- [ ] Reload failure or missing confirmation becomes an actionable failed or timed-out status rather than a false completion.
- [ ] Old contexts reject use after reload, and no old-runtime timer or callback performs additional work after invoking reload.
- [ ] Session state and unrelated extension behavior remain intact across reload.
- [ ] TUI, RPC, JSON, and print modes either pass the supported integration path or fail explicitly without UI assumptions.
- [ ] Removing or disabling the extension and starting a new Pi process restores an unpatched runtime.

## Validation

- Unit-test private module resolution, version/fingerprint acceptance and rejection, idempotent patch installation, symbol non-enumerability, original-context preservation, and unsupported-runtime failure.
- Test request persistence, queued-only results, duplicate coalescing, settlement scheduling, generation reconstruction, timeout/failure reporting, and stale-context rejection.
- Use a real Pi 0.82.1 child process with a deterministic scripted provider or fixture. Have the model call the reload tool while busy and record tool, settlement, shutdown, startup, resource, and provider-input events outside the reloaded runtime.
- Assert the exact ordering: tool completion and assistant settlement precede one reload; no slash command or synthetic reload request appears in provider context; new-generation confirmation follows startup.
- Change a runtime sentinel, request reload, and assert a subsequent tool call reports the changed sentinel and a new generation exactly once.
- Exercise repeated reloads and supported TUI, RPC, JSON, and print-mode paths, including unsupported-mode errors where necessary.
- Run focused extension tests, then `npm run check`.
- During evaluation, compare same-session live-verification success with the baseline blocked run and record reload failures, duplicate reloads, stale-generation confirmations, unsupported-version rejections, and lost session state.

## Evaluation

- **Window:** Not started; after approved implementation, 10 same-session extension verification runs including at least 3 busy-agent requests and 2 repeated reloads, or 2026-08-20, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending implementation decision and evaluation
