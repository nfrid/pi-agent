# HFM-20260805: Use project-native delegate worktree setup

- **Status:** evaluation-pending
- **Approval:** approved 2026-08-05
- **Created:** 2026-08-05
- **Source reports:** [HF-20260804: Dropping delegate worktrees breaks parent workspace dependencies](../inbox/20260804T095043Z-delegate-worktree-drop-breaks-parent-node-modules.md); [HF-20260804: Delegate worktree installs leak pnpm links into the parent checkout](../inbox/20260804T180339Z-delegate-worktree-pnpm-links-leak.md)

## Problem

Delegate worktree preparation currently bypasses repository Git hooks, symlinks parent `node_modules` directories into the child, and copies a hard-coded list of `.env` files. The dependency links violate worktree isolation and can corrupt the parent. The copied-file list and Node-specific package discovery cannot correctly prepare npm, pnpm, Bun, Rust, Go, polyglot, or project-specific environments.

## Baseline

Two pnpm failures exposed the shared-state defect: parent dependency links resolved through delegate worktrees, then became stale or dangling when those worktrees were dropped. Both required a parent reinstall. In `extensions/delegate/worktree/create.ts`, worktrees are created with `core.hooksPath=/dev/null`, then `linkDependencies()` projects discovered `node_modules` directories and `carryFiles()` copies four predefined `.env` names. The harness therefore disables the project's native setup mechanism and substitutes incomplete harness-owned setup policy.

## Hypothesis

If delegate worktrees use normal Git hook behavior and the harness removes dependency projection and hard-coded ignored-file copying, then each project can prepare dependencies, environment files, generated configuration, or no setup at all using its own native tooling. This should preserve checkout isolation across languages while allowing package managers to reuse their normal caches rather than necessarily downloading every dependency again.

## Guardrails

- Never share mutable repository-local dependency or build directories between worktrees by symlink or hard link.
- Do not add package-manager or language adapters to the harness.
- Do not invent a second harness-specific setup-hook format.
- Treat repository Git hooks as executable project code under the same trust boundary as other repository commands; surface hook failures and do not silently bypass them.
- Do not automatically create, modify, or recommend secret-bearing environment files without an explicit project policy.
- Preserve WIP carry, branch provenance, commit exclusion, cleanup, and continuation semantics.
- Document that hook-created ignored files are environment setup, not source snapshot content; exact source snapshots remain Git/WIP based.
- Do not automatically run an additional install command after hooks complete.

## Options considered

1. **Honor native Git worktree hooks and remove harness setup policy:** Project-owned, language-neutral, and consistent with direct `git worktree add`; requires projects that need setup to configure hooks.
2. **Add a Pi-specific project setup hook:** Easier to constrain, but duplicates native tooling and makes setup harness-dependent.
3. **Keep links and add package-manager adapters:** Fast when it works, but unsafe and permanently incomplete.
4. **Copy dependencies or use filesystem copy-on-write:** Better isolation, but expensive or platform-dependent and still does not handle environment files and arbitrary project setup.
5. **Ship a global worktree-setup skill:** Could help author hooks, but adds maintenance before evidence that models or project documentation are insufficient.

## Recommendation

Use option 1. Stop forcing `core.hooksPath=/dev/null` for delegate worktree creation and rehydration. Remove automatic `node_modules` linking, package-manifest discovery used only for linking, and hard-coded `.env` copying. Let the repository's configured native hooks perform idempotent worktree setup and fail delegate preparation clearly when setup fails.

A project hook may run `npm install`, `pnpm install`, `bun install`, `cargo fetch`, copy or generate approved environment files, or do nothing. Each worktree still needs its local dependency layout materialized, but normal package-manager caches can avoid repeated downloads. Add concise documentation with a generic hook example and security warning. Do not create a global skill unless repeated setup friction later shows that documentation and normal model knowledge are insufficient.

## Scope

- **In:** Native hook execution during fresh worktree creation and rehydration; removal of dependency linking and predefined `.env` carry; lifecycle records/tests cleanup; setup-failure reporting; concise project-configuration documentation.
- **Out:** Pi-specific hook formats; automatic dependency installation; package-manager detection; generated hook installation; secret management; a global setup skill; copy-on-write filesystems; external cache policy.

## Acceptance criteria

- [ ] Delegate worktree creation and rehydration honor the repository's configured native Git hooks instead of overriding `core.hooksPath`.
- [ ] The harness creates no `node_modules` or other dependency symlink from a delegate worktree to the parent.
- [ ] The harness no longer discovers Node package directories or copies a predefined list of `.env` files during worktree setup.
- [ ] A fixture hook can create an ignored setup file and a child-local dependency/build directory before delegate launch.
- [ ] Replacing or deleting hook-created child files cannot mutate the parent or a sibling worktree.
- [ ] Hook failure aborts preparation with a bounded actionable error and cleans the partially created worktree.
- [ ] Projects without hooks retain ordinary clean-worktree behavior and receive no implicit install.
- [ ] WIP carry, branch integration, commit exclusion, drop, refresh, and read-only source snapshot tests continue to pass.
- [ ] Documentation explains that setup may materialize dependencies per worktree while reusing tool-native caches, and that hook code executes with repository-command privileges.

## Validation

Add fixtures for no hook, successful configured hook, failing hook, custom `core.hooksPath`, ignored setup files, child-local mutable directories, fresh creation, snapshot rehydration, cleanup after failure, and concurrent sibling worktrees. Assert no harness-created links or predefined environment copies and no setup artifacts in delegate commits. Retain WIP and lifecycle regression tests, then run `npm run check`.

## Evaluation

- **Window:** After an approved merge, the first 10 isolated delegate worktrees across at least 3 repositories or 2 toolchains, including 3 hook-configured worktrees, or 2026-09-30, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare against two parent dependency corruptions and the current implicit setup behavior. Keep only if no parent or sibling mutation occurs, hook-configured projects become usable without parent repair, hookless projects behave predictably, and setup overhead does not require harness package-manager special cases.

## Implementation and resolution

- **Approved implementation:** Honor configured native Git hooks during delegate worktree creation and rehydration; remove harness-managed dependency symlinks, Node package discovery used for projection, and predefined `.env` copying; preserve lifecycle and source-snapshot semantics; document project-owned idempotent setup and its trust boundary without adding package-manager adapters, a Pi-specific hook format, or a global setup skill. Approved by the user on 2026-08-05.
- **Implemented:** Native hook setup, isolated child-local state, bounded setup-failure cleanup, commit-hook suppression for synthetic commits, lifecycle metadata cleanup, regression tests, and delegation documentation are implemented in this change.
- **Merged change:** `d3b0fc9` (`Merge branch 'pi/implement-native-worktree-hooks'`)
- **Resolution:** pending evaluation
