# HFM-20260805: Add a session-scoped delegate branch inventory

- **Status:** proposed
- **Approval:** approved 2026-08-05
- **Created:** 2026-08-05
- **Source reports:** [HF-20260804: Delegate branch listing mixes unrelated historical work](../inbox/20260804T180340Z-delegate-branch-list-session-noise.md); [HF-20260805: Delegate branch listing lacks a session-scoped view](../inbox/20260805T111944Z-branch-list-needs-session-filter.md)

## Problem

`delegate_branches list` returns every retained branch and read-only snapshot known to the repository. In a long-lived repository, unrelated historical records obscure the current session's cleanup state and increase the risk of acting on the wrong record.

## Baseline

Two consecutive sessions observed the same deterministic behavior: a cleanup inventory mixed six current branches with dozens of historical records, and a later inventory still returned more than thirty unrelated snapshot, merged, unmerged, and gone entries after current work was cleaned up. `extensions/delegate/branches-tool.ts` exposes no list selector and calls `listBranchEntries()` without session context; records contain session lifecycle identity, but listing does not use it to foreground current work.

## Hypothesis

If branch listing defaults to records created or touched by the current session and offers an explicit repository-history view, then routine cleanup will produce a bounded, unambiguous inventory without removing access to recovery records.

## Guardrails

- Preserve an explicit all-history view for cross-session recovery and maintenance.
- Never hide a record merely because it is unmerged when the caller explicitly requests repository history.
- Define session membership from stored lifecycle identity, not branch-name heuristics.
- Keep ownership checks for review, merge, and drop unchanged.
- Represent an empty session inventory explicitly rather than falling back to all history.

## Options considered

1. **Default to current session with an `all` selector:** Best routine ergonomics and smallest output; changes the existing default.
2. **Keep all-history default and add a `session` selector:** Backward compatible, but agents must remember the filter during every cleanup.
3. **Add only an actionable-state filter:** Reduces gone/merged noise but still mixes unrelated unmerged work across sessions.

## Recommendation

Default `list` to the current session and add an explicit scope selector for all repository history. A separate actionable-only state filter may be added only if it composes clearly with scope and does not redefine ownership.

## Scope

- **In:** `delegate_branches list` scope; current-session membership; explicit all-history access; list tests and tool documentation.
- **Out:** Automatic deletion, retention policy, branch ownership changes, or hiding historical records from explicit recovery queries.

## Acceptance criteria

- [ ] Default listing shows only writable branches and read-only snapshots created or touched by the current session.
- [ ] After all current records are dropped, default listing reports no current entries even when repository history remains.
- [ ] An explicit all-history selector returns the existing repository-wide inventory.
- [ ] Current-session listing includes relevant continued or refreshed records according to documented session-touch semantics.
- [ ] Review, merge, and drop behavior and ownership validation remain unchanged.

## Validation

Create records owned by current and foreign sessions across snapshot, merged, unmerged, and gone states. Assert default, empty-current, continued/refreshed, and explicit all-history outputs, then run focused delegate branch tool tests and `npm run check`.

## Evaluation

- **Window:** After an approved merge, the first 10 end-of-task delegate cleanup inventories across at least 3 sessions, or 2026-09-30, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of more than thirty unrelated records and manual identification of six current branches. Keep only if every routine inventory identifies all current records without unrelated history and explicit recovery can still find older records.

## Implementation and resolution

- **Approved implementation:** Default `delegate_branches list` to records created or touched by the current session, add an explicit all-history scope, preserve ownership and lifecycle behavior, and report an empty current-session inventory without falling back to history; approved by the user on 2026-08-05.
- **Merged change:** —
- **Resolution:** pending evaluation
