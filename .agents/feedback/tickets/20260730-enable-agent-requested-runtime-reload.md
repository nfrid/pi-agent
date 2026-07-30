# HFM-20260730: Enable agent-requested runtime reload

- **Status:** parked
- **Approval:** not approved
- **Created:** 2026-07-30
- **Source reports:** [HF-20260729: Agent cannot reload extension runtime after updating it](../inbox/20260729T141648Z-agent-cannot-reload-extension-runtime.md)
- **Decision:** Parked 2026-07-30 until Pi supports or verifies public deferred extension-command dispatch from an LLM-callable tool; private runtime workarounds are not acceptable

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

After the harness changes an extension, the active Pi session continues using the extension instance loaded before the change. The agent can run static and unit checks but cannot prove that subsequent tool calls use the new runtime without user-triggered `/reload` or a replacement session.

Pi 0.82.1 documents a local design: a command calls `await ctx.reload(); return`, while an LLM-callable tool queues that command as a follow-up user message. Inspection of the installed runtime contradicts the example: extension-command dispatch is gated on prompt expansion, while `sendUserMessage()` explicitly disables prompt expansion. The queued slash command can therefore become ordinary prompt text instead of executing as a command. A repository-local implementation is not safe to approve until supported public behavior is verified or fixed upstream.

## Baseline

One harness-maintenance session merged extension fixes and passed focused lifecycle tests, but intentionally deferred live verification because the current process retained the old extension runtime.

Installed Pi 0.82.1 provides `ctx.reload()` only to extension command contexts. Its documentation requires reload to be terminal for the old command handler because code after `await ctx.reload()` still runs in the stale call frame. The documented `reload-runtime.ts` example queues a registered command with `pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" })`.

In the installed runtime, extension-command dispatch occurs only when `expandPromptTemplates` is true (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`, installed 0.82.1 lines 797–805), but `sendUserMessage()` invokes the prompt path with that option false (lines 1125–1131). This documentation/runtime mismatch blocks a supported tool-to-command handoff. No current harness extension exposes reload, and no existing ticket covers it.

## Hypothesis

If Pi's public API can queue and execute a registered extension command exactly once as a deferred follow-up, then a small harness extension can request reload after current agent work settles and confirm from the new runtime that future calls use the refreshed extension generation.

This hypothesis remains untestable through supported APIs on the current pinned runtime until the command-dispatch mismatch is resolved or a real integration test proves the documented behavior works.

## Guardrails

- Do not monkeypatch Pi internals, import private runtime classes, invoke hidden runner methods, or patch installed dependencies locally.
- Reload only through documented public extension APIs.
- Treat `await ctx.reload(); return;` as terminal; do not use old `ctx`, `pi`, timers, or in-memory extension state afterward.
- The initiating tool may report only that a request was queued, never that reload completed.
- Confirmation must come from the new runtime instance after `session_start` with reason `reload`.
- Queue exactly one reload after the current agent/tool work settles; do not reload during tool execution.
- Use collision-resistant command and tool names and reject ambiguous duplicate registrations.
- Preserve session state and existing extension shutdown/startup semantics.
- Make no TUI-only assumptions in RPC, JSON, or print modes.

## Options considered

1. **Keep manual `/reload` or start a new session:** Safe and available now, but preserves user intervention and blocks autonomous same-session verification.
2. **Implement the documented command/tool bridge locally now:** Small in principle, but the installed runtime contradicts the documentation and may send the command to the model as prompt text.
3. **Wait for an upstream fix or verified supported behavior, then add the local bridge:** Preserves public lifecycle boundaries and permits a small, testable extension once unblocked.
4. **Use private runtime hooks or monkeypatch command dispatch:** Could bypass the mismatch, but is brittle, unsafe across upgrades, and outside the harness's maintenance boundary.

## Recommendation

Park the ticket and use option 1 temporarily. Unpark only after the exact supported Pi version passes an integration test showing that a tool can queue a registered command through public APIs and that the command executes exactly once after settlement rather than entering model context.

Once unblocked, implement option 3 as one guarded extension with a collision-resistant command and tool. Add a runtime generation marker reconstructed by the newly loaded instance so a later tool call can distinguish queued, completed, and failed reloads.

## Scope

- **In:** Upstream/public-API unblock verification; one local reload command/tool after unblock; lifecycle generation confirmation; duplicate and mode guards; focused and integration tests.
- **Out:** Private APIs; installed-package patches; direct reload from tool context; mid-execution reload; unrelated resource watching; automatic reload after every file change.

## Acceptance criteria

### Unblock criteria

- [ ] On the exact supported Pi version, a tool uses only public APIs to queue a registered reload command with follow-up delivery.
- [ ] The command executes exactly once after current tool and assistant work settle; its literal slash text is not sent to the model as ordinary input.
- [ ] Reload emits `session_shutdown` with reason `reload`, reloads resources, and emits `session_start` with reason `reload` without duplicate command or tool registration.
- [ ] A real Pi integration test demonstrates the supported behavior; documentation alone is insufficient.

### Local implementation criteria after unblock

- [ ] The command handler performs `await ctx.reload(); return;` and uses no stale runtime state afterward.
- [ ] The initiating tool reports queued status only.
- [ ] A subsequent call receives confirmation produced by the new runtime generation, including actionable failure or timeout reporting.
- [ ] Repeated requests cannot cause overlapping or duplicate reloads.
- [ ] Command and tool names do not collide with existing registrations or rely on numeric suffix/first-registration behavior.
- [ ] TUI, RPC, JSON, and print modes either work through public APIs or fail explicitly without UI assumptions.
- [ ] Session state and unrelated extension behavior remain intact across reload.

## Validation

- Preserve an expected-failure integration fixture on Pi 0.82.1 that reproduces the queued slash command not dispatching through the documented bridge.
- On the candidate upstream-fixed Pi version, rerun that fixture and require the queued command to execute exactly once without appearing in model context before changing this ticket from parked.
- After unblocking, unit-test registration, follow-up delivery options, terminal command behavior, lifecycle marker restoration, duplicate prevention, and failure reporting.
- Change a runtime sentinel, request reload while the agent is busy, and assert a subsequent tool call reports the new sentinel and generation exactly once.
- Exercise repeated reloads and the supported TUI, RPC, JSON, and print-mode paths.
- Run focused extension tests, then `npm run check`.
- During evaluation, compare same-session live-verification success with the baseline blocked run and record reload failures, duplicate reloads, stale-generation confirmations, and lost session state.

## Evaluation

- **Window:** Not started; after unblock and approved implementation, 10 same-session extension verification runs including at least 3 busy-agent requests and 2 repeated reloads, or 2026-08-20, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** parked pending supported public command dispatch
