# HFM-20260731: Add squash integration for writable delegates

- **Status:** parked
- **Approval:** not approved
- **Created:** 2026-07-31
- **Source reports:** [HF-20260731: Delegate integration cannot squash a retained branch](../inbox/20260731T085514Z-delegate-clean-integration.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

A writable delegate can leave a correct reviewed tree on a branch whose intermediate commit history violates the parent repository's commit policy. `delegate_branches merge` can integrate only that existing history, so the observed task used a second writable delegate to replay an already reviewed 13-path diff into one Conventional Commit.

## Baseline

The retained branch contained malformed partial commit `a6e6474 JSON contract implementer` plus valid follow-ups. A clean replay branch was required solely to produce `311d1ec feat(cli): add versioned JSON output contract`; exact-tree comparison found no product difference.

The current schema in `extensions/delegate/branches-tool.ts` exposes only `list`, `review`, `merge`, and `drop`. `mergeBranch` in `extensions/delegate/worktree/integrate.ts` uses either `git cherry-pick --no-edit <recorded range>` for carried WIP or `git merge --no-ff --no-edit <branch>`, preserving branch commit subjects. There is no safety-wrapped final-tree/squash mode or caller-supplied subject in that tool. However, the parent is not capability-blocked: it has Bash and Git access and can use `git merge --squash` for an ordinary branch or deliberately apply only the validated task range for a carried-WIP branch, then commit with its chosen subject. The missing piece is convenience and standardized guardrails, not underlying squash capability.

## Hypothesis

If integration can apply the already reviewed task range as one parent-authored commit with an explicit subject, then agents can satisfy repository history policy without replaying file state, while retaining the existing fail-closed conflict and dirty-path protections.

## Guardrails

- Default `merge` behavior and history preservation remain unchanged.
- Squash integration must use the same validated recorded task range and exclude carried parent WIP.
- Refuse when parent HEAD or overlapping dirty paths make the reviewed result unsafe; failure must leave the checkout unchanged.
- Do not rewrite, rebase, or delete the retained delegate branch.
- Require an explicit nonempty commit subject; do not invent or silently normalize repository policy.
- Do not bypass branch review or project validation requirements.

## Options considered

1. **Add an explicit squash integration mode:** Applies the validated final task delta once with a caller-supplied subject; adds a bounded API and conflict path.
2. **Preserve child history by default and let the parent squash manually when needed:** Keeps useful delegate commits and uses capabilities already available to the parent, but requires careful range selection and rollback in the uncommon squash case.
3. **Automatically squash every delegate branch:** Produces clean parent history but discards useful child commits and changes current semantics without caller intent.

## Recommendation

Park the ticket and use option 2. Unsquashed integration should remain the default because delegate commits are useful review and recovery history, while the parent can already choose a manual squash when repository policy requires it. Reconsider option 1 after at least three independent tasks require manual squash integration and show repeated range-selection, conflict-cleanup, or WIP-exclusion cost; a second full delegate replay caused only by commit history also qualifies for reconsideration.

## Scope

- **In:** Opt-in squash/final-tree integration for writable retained branches; explicit subject; carried-WIP exclusion; dirty-path and conflict rollback; focused schema and integration tests.
- **Out:** Default merge changes; arbitrary history editing; automatic subject generation; branch deletion; read-only snapshots; bypassing review or validation.

## Acceptance criteria

- [ ] Opt-in squash integration lands the reviewed task delta as exactly one new parent commit with the caller-supplied subject.
- [ ] The resulting task-path tree matches the retained branch while carried parent WIP is not re-applied as delegate work.
- [ ] Default merge preserves its current merge/cherry-pick behavior and commit history.
- [ ] Conflicts, invalid recorded ranges, overlapping parent changes, and commit failures leave the parent checkout at its original HEAD and worktree state with actionable output.
- [ ] The retained delegate branch and its commits remain reviewable and droppable after squash integration.
- [ ] Read-only snapshots reject squash integration.

## Validation

Extend `extensions/delegate/integrate.test.ts` and `branches-tool.test.ts` with normal and carried-WIP squash cases, subject validation, tree equivalence, default-mode preservation, dirty overlap, conflicts, and injected commit failure. Run focused delegate branch/integration tests, then `npm run check`.

## Evaluation

- **Window:** Not started; if approved after reconsideration, the first 10 opt-in squash integrations or 2026-09-30, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline one full delegate replay for one unsuitable history. Keep only if successful cases require no replay, produce the requested single commit, and cause no tree mismatch, WIP duplication, or failed rollback. Record `insufficient evidence` if fewer than 3 qualifying integrations occur.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
