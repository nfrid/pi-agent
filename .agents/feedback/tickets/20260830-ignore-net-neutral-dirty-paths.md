# HFM-20260830: Ignore net-neutral paths in delegate merge guards

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-08-30
- **Source reports:** [HF-20260812: Delegate merge blocks a net-neutral path that is dirty in the parent](../inbox/20260812T111745Z-delegate-merge-net-neutral-path.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

A carried delegate branch can be refused because an intermediate task commit touched a parent-dirty path even when a later task commit exactly restores that path and the branch tip has no net task diff there.

## Baseline

The source report records two refused merges after `docs/delegation.md` was added and then exactly removed; branch metadata's final changed-path list excluded it, yet the merge guard still treated it as incoming. A third branch with the same seven-path final implementation merged only after reconstructing history that never touched the dirty file. Current `packages/worktree-manager/src/integrate.ts` still computes carried incoming paths from the unintegrated task commit list, while normal branches use a base-to-tip `git diff --name-only`; the carried path union can therefore retain a net-neutral intermediate path.

## Hypothesis

If dirty-path overlap is computed from the exact patch that integration will apply, excluding paths whose cumulative task delta is empty, then net-neutral history will no longer block safe integration while every path with a real incoming change remains protected.

## Guardrails

- Never overwrite or stage a parent-dirty path with a non-empty incoming task delta.
- Preserve carried-WIP exclusions and patch-aware skipping of already integrated task commits.
- Derive overlap from the same commit subset and integration base used by the pending merge.
- Fail closed when the task range is invalid, ambiguous, or changes during preflight.
- Do not weaken conflict handling or promise semantic equivalence beyond an empty textual patch.

## Options considered

1. **Compute cumulative incoming paths from the pending patch:** Matches actual integration and removes only exact net-neutral paths.
2. **Use the union of touched paths:** Simple and current, but creates false conflicts after exact restoration.
3. **Ignore all parent-dirty paths and rely on Git:** Risks overwriting or entangling unrelated parent work.

## Recommendation

Implement option 1. Materialize or inspect the cumulative patch for the exact unintegrated task commits, and compare parent dirt only with paths that have a non-empty resulting delta. Keep the existing abort-and-restore conflict boundary.

## Scope

- **In:** Carried-branch dirty-overlap preflight; exact cumulative task delta; restored-path tests; bounded refusal output.
- **Out:** Semantic equivalence; automatic conflict resolution; cleanup/drop equivalence; rebased-record refresh; unrelated normal-branch merge policy.

## Acceptance criteria

- [ ] A parent-dirty path touched and then exactly restored by the pending task commits does not block merge.
- [ ] A parent-dirty path with any non-empty cumulative task delta still blocks merge before checkout mutation.
- [ ] Partial patch-equivalent integration computes overlap from only the remaining task commits.
- [ ] Renames, deletes, mode changes, binary files, empty commits, and repeated path touches are handled deterministically and fail closed when indeterminate.
- [ ] Refusal and failed integration leave parent HEAD, index, working tree, and untracked files unchanged.

## Validation

Extend worktree-manager and delegate integration fixtures with add/remove restoration, edit/revert restoration, mode-only and binary changes, renames, partial patch-equivalent integration, advancing refs, and genuine dirty overlap. Assert preflight paths and exact before/after checkout state, then run the focused worktree-manager and delegate integration suites plus their scoped typecheck and Biome checks.

## Evaluation

- **Window:** Not started; after an approved merge, the first 10 carried-branch integrations with parent WIP including at least 3 net-neutral-path fixtures or live cases, or 2026-10-31, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of two false refusals and two transplant delegates. Keep only if every exact net-neutral path integrates without reconstruction, every real dirty overlap remains blocked, and no parent work is changed.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
