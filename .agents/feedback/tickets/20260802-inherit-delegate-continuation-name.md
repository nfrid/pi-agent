# HFM-20260802: Inherit delegate continuation display names

- **Status:** approved
- **Approval:** approved 2026-08-02
- **Created:** 2026-08-02
- **Source reports:** [HF-20260802: Delegate continuation requires repeating the subagent name](../inbox/20260802T103852Z-delegate-continuation-requires-name.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

A continuation token preserves a delegate's session and execution policy, but a single-task continuation is rejected unless the caller also repeats the subagent display name. The token already identifies the lineage, so the extra requirement creates a deterministic retry and forces callers to retain presentation metadata solely to pass validation.

## Baseline

One continuation call supplied a valid token and follow-up task but omitted `name`; it failed with `Delegate name is required with task.` Repeating the existing name with the same token and task succeeded.

Current source explains the behavior:

- `normalizeInputs` in `extensions/delegate/plans.ts` rejects a missing single-task `name` before `buildDelegatePlans` resolves the continuation token.
- The top-level delegate schema makes `name` optional syntactically, while its description and normalization require it for every `task` call.
- `DelegateSessionMetadata` in `extensions/delegate/session.ts` persists cwd, worktree, capability, isolation, scope, and routing, but not the display name.
- Status grouping already treats the continuation token as lineage identity; the displayed name is run metadata rather than session authority.

No existing feedback ticket covers continuation display-name persistence or validation. Snapshot refresh, timeout recovery, and incremental review tickets concern distinct continuation behaviors.

## Hypothesis

If a fresh delegate's display name is persisted with its continuation metadata and omitted names are resolved only after a valid continuation token is loaded, then `{ task, continuation }` will resume that lineage without a redundant retry because the harness can reuse the original display name. This is falsified if a valid new token still rejects an omitted name, a fresh nameless task succeeds, or the resumed run displays an unintended name.

## Guardrails

- Keep `name` required for every fresh single or batched task.
- Treat the continuation token, not the display name, as the authority for session, route, capability, isolation, and workspace state.
- Do not infer names from task prose, route labels, branch names, or filesystem metadata.
- Preserve explicit names on continuations as supported display-name overrides unless separately deprecated.
- For legacy continuation metadata without a stored name, require an explicit name and return an actionable compatibility error; do not invent one silently.
- Do not change continuation lifetime, token validation, routing, worktree behavior, or status grouping.

## Options considered

1. **Persist and inherit the display name:** Removes redundant input for new continuations while retaining explicit override behavior; requires a backward-compatible metadata change.
2. **Resolve the token first but require a name stored elsewhere:** Avoids metadata expansion only if another durable source is reliable; current session and status records do not provide one.
3. **Keep requiring the name and clarify documentation:** Avoids code changes but preserves the observed failed call and redundant identity replay.

## Recommendation

Persist the fresh run's normalized display name in delegate session metadata. During planning, resolve a supplied continuation before enforcing the single-task or per-item name requirement; inherit the stored name when omitted, preserve an explicit override, and fail clearly for legacy metadata that has no stored name.

## Scope

- **In:** Delegate session metadata; single and batched continuation normalization; inherited and explicit display names; legacy-session compatibility; focused planning and persistence tests.
- **Out:** Token format or lifetime; routing and capability inheritance; workspace refresh; name uniqueness; status grouping; automatic renaming.

## Acceptance criteria

- [ ] A continuation created after the change accepts a follow-up task with `continuation` and no `name`, and displays the persisted name.
- [ ] A fresh task without `name` remains rejected before launch.
- [ ] A batched continuation item may omit `name` when its valid token has a persisted name, while fresh batch items still require names.
- [ ] An explicit continuation name remains the displayed override without changing lineage identity.
- [ ] A valid legacy token lacking stored name fails with a compatibility-specific instruction to supply `name`.
- [ ] Invalid or expired tokens cannot bypass name or continuation validation.

## Validation

- Add session metadata create/resolve and backward-compatibility tests for persisted names.
- Add planning/tool tests for fresh nameless rejection, inherited single continuation, mixed fresh/continuation batches, explicit override, legacy metadata, and invalid tokens.
- Run the focused delegate planning, orchestration, and session tests, then `npm run check`.
- Compare omitted-name validation failures and wrong-name observations against the baseline during the evaluation window.

## Evaluation

- **Window:** After an approved merged implementation, until 20 continuation calls using newly created tokens have completed or 2026-08-16, whichever is later; include at least 5 batched continuation items and 3 explicit overrides.
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** Persist fresh delegate display names and inherit them when valid new-format continuations omit `name`, with explicit overrides and legacy compatibility behavior; approved 2026-08-02.
- **Merged change:** —
- **Resolution:** pending evaluation
