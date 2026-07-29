# HFM-20260729: Link dependencies for carried WIP packages

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-07-29
- **Source reports:** [HF-20260729: Read-only review worktrees cannot run dependency-backed checks](../inbox/20260729T103916Z-readonly-worktree-dependencies.md)

## Problem

An isolated read-only delegate reviewing a newly created, uncommitted package can receive the package source but not its installed dependencies, so repository checks available in the parent checkout fail in the review worktree.

## Baseline

Multiple isolated review delegates received the uncommitted `kibana-logs` package and reported that its check could not run because `tsc` was unavailable; the same check passed in the parent checkout with installed dependencies. Current worktree preparation links `node_modules` for package directories returned by `git ls-files ... package.json` (`extensions/delegate/worktree/create.ts`). It then carries untracked WIP files into the worktree. An untracked new package manifest is therefore absent from the parent-side package-directory query even though its source is carried, explaining why existing dependency linking covers tracked packages but misses this task shape.

## Hypothesis

If worktree preparation discovers package directories from the effective WIP snapshot, including untracked non-ignored manifests, then isolated delegates reviewing new packages will find the parent package's installed `node_modules` and run the same dependency-backed checks, because dependency linking will include directories currently omitted by `git ls-files`.

## Guardrails

- Link only existing dependency directories from within the same repository root; never install dependencies automatically.
- Do not copy dependency trees or commit injected links.
- Preserve `from: head` semantics: uncommitted package manifests and dependencies must not leak into a HEAD-only snapshot.
- Bound discovery and retain the existing maximum linked-package limit.
- Do not broaden carried ignored files beyond the existing explicit policy.

## Options considered

1. **Include untracked package manifests when preparing a WIP worktree:** Directly matches the carried snapshot and existing symlink design, but must preserve limits and ignore rules.
2. **Discover package directories inside the prepared worktree:** Uses the effective snapshot naturally, but still needs a safe mapping back to parent dependency paths and clear `from: head` behavior.
3. **Allow ephemeral installs in read-only worktrees:** Works without parent dependencies, but adds network, time, lockfile, lifecycle, and reproducibility costs beyond the observed gap.

## Recommendation

Extend dependency discovery for `from: wip` to include untracked, non-ignored package manifests that will be carried into the worktree, then reuse the existing parent-to-worktree `node_modules` symlink path. Keep `from: head` restricted to tracked manifests.

## Scope

- **In:** New untracked package manifests in WIP snapshots; existing parent `node_modules` links; cleanup and focused worktree tests.
- **Out:** Dependency installation, global/shared caches, dependencies outside the repository, arbitrary ignored package trees, or changes to source-write capability.

## Acceptance criteria

- [ ] A WIP worktree for an untracked package with an existing parent `node_modules` receives a usable dependency link at that package path.
- [ ] The equivalent `from: head` worktree does not receive the untracked package or dependency link.
- [ ] Tracked package dependency linking continues to work.
- [ ] Missing parent dependencies remain a nonfatal condition and trigger no install.
- [ ] Injected dependency links remain absent from delegate commits and are cleaned up with the worktree.

## Validation

- Extend the worktree fixture with an untracked nested package manifest and dependency-backed executable/typecheck stub.
- Assert WIP versus HEAD package/link visibility and run a command through the WIP link.
- Retain or add cleanup/finish assertions proving the link is not committed.
- Run the focused delegate worktree tests, then `npm run check`.
- During the evaluation window, compare dependency-backed check availability in isolated reviews of new packages with the baseline where multiple reviewers could not run `tsc`; watch for snapshot leakage or cleanup failures.

## Evaluation

- **Window:** First 10 isolated reviews of WIP packages, or 21 days after merge, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
