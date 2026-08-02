# HFM-20260802: Forward the parent HOME to delegates

- **Status:** approved
- **Approval:** approved 2026-08-02
- **Created:** 2026-08-02
- **Source reports:** [HF-20260802: Delegate sandbox exposes an unwritable HOME](../inbox/20260802T103953Z-delegate-home-unwritable.md)
- **Decision:** Revised and approved 2026-08-02 to forward the real parent HOME rather than create an isolated temporary HOME

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

Delegate child processes receive no `HOME` environment variable. Commands that use ordinary home-relative cache, configuration, or user-local installation paths therefore resolve locations such as `$HOME/.local` to `/.local`, which is not writable. Repository verification can compile successfully but fail only at its user-local step, and tools cannot discover the user's normal `~/.config`, `~/.cache`, `~/.local`, or other home-relative state.

This harness does not claim to sandbox delegates: agents can run Bash and access absolute user paths under the same account, subject to their tool capability and instructions. Giving delegates a synthetic HOME would therefore add compatibility differences without establishing a meaningful security boundary.

## Baseline

Multiple writable and read-only delegates building the same Swift package compiled its source but could not complete `make build` because its linking step targeted `/.local`. One delegate succeeded only with `HOME=/tmp/piles-home`; the unchanged verifier then succeeded in the parent and linked under `/Users/nfrid/.local`.

Current source makes the missing environment deterministic:

- `spawnDelegateChild` in `extensions/delegate/delegate-child.ts` replaces the child environment with `PATH`, `LANG`, `LC_ALL`, worktree additions, and `PI_DELEGATE_CHILD`; it does not set `HOME`.
- `runDelegate` in `extensions/delegate/runner.ts` contributes only the prepared worktree environment, which carries worktree-specific metadata rather than a home directory.
- With `HOME` absent, shell expansion of `$(HOME)/.local/bin` produces `/.local/bin`; supplying the parent HOME produces the same user-relative path used by the parent process.

No existing ticket covers delegate `HOME`, XDG paths, or child process environment construction. The carried-package dependency ticket addresses repository `node_modules` projection and is not a duplicate.

## Hypothesis

If the child environment explicitly receives the parent's effective HOME, then shell expansion, tilde resolution, and tools using conventional home-relative defaults will behave the same in delegates as in the parent, eliminating `/.local` failures and synthetic-home compatibility gaps. This is falsified if a delegate still resolves home-relative paths under `/`, sees a different home from the parent, or existing child startup and worktree behavior regress.

## Guardrails

- Forward only the effective parent HOME as part of this ticket; do not inherit the complete parent environment.
- Preserve cwd, PATH and locale policy, `PI_DELEGATE_CHILD`, worktree metadata, source-write capability, routing, cancellation, and session behavior.
- Use a deterministic fallback such as Node's `homedir()` only when the parent `HOME` variable is absent or empty; reject or surface an unusable result rather than silently choosing `/`.
- Do not copy, rewrite, seed, clean, or otherwise manage the user's home contents.
- Do not claim that read-only delegation or the environment allowlist is an OS filesystem sandbox. A delegate may already access or mutate user-owned paths through allowed tools and is governed by task instructions.
- Do not add automatic package installation, shell-profile sourcing, XDG-variable forwarding, a persistent cache service, or broader environment-policy redesign without separate evidence.
- Preserve the existing distinction between source-write capability and general process permissions; this ticket changes HOME discovery, not the tool capability model.

## Options considered

1. **Forward the parent's real HOME:** Matches the harness trust model and gives tools the same `~/.config`, `~/.cache`, and `~/.local` defaults as the parent; delegates can mutate shared user state, but they can already reach it by absolute path through allowed Bash commands.
2. **Create a temporary isolated HOME:** Avoids incidental shared-state writes, but hides normal configuration and installed user-local tools, loses state between attempts, and does not create meaningful isolation while absolute home paths remain accessible.
3. **Require task-specific `HOME=/tmp/...` or real-HOME overrides:** No harness change, but every delegate must diagnose and work around the same false-negative environment behavior.
4. **Forward the entire parent environment:** Maximizes compatibility, but unnecessarily broadens this ticket to credentials, runtime flags, and unrelated ambient state.

## Recommendation

At the child-spawn boundary, set `HOME` to the parent's nonempty `process.env.HOME`, falling back to Node's effective `homedir()` when necessary. Keep the rest of the current environment allowlist unchanged. Do not create or clean directories and do not introduce a separate home lifecycle: delegates should observe the same home-relative filesystem state as the parent process.

## Scope

- **In:** Delegate child HOME construction; parent-HOME forwarding and fallback; shell/home-resolution tests; existing child and worktree regression coverage.
- **Out:** Temporary homes; parent-home copying or cleanup; XDG-variable forwarding; full environment inheritance; dependency projection; shell-profile sourcing; OS sandboxing or filesystem permissions.

## Acceptance criteria

- [ ] Every launched delegate receives a nonempty HOME equal to the parent's effective HOME, with a deterministic non-root fallback when the variable is absent.
- [ ] `$HOME`, shell `~`, and ordinary home-relative defaults resolve to the same directory in the delegate and parent.
- [ ] A verifier fixture writing or linking under `$HOME/.local` no longer targets `/.local` and requires no inline environment override.
- [ ] Existing contents under `~/.config`, `~/.cache`, and `~/.local` remain discoverable through normal home-relative paths without copying them.
- [ ] Child Pi startup, provider authentication, route selection, sessions, continuations, and writable/read-only worktrees remain functional.
- [ ] No parent environment variables other than HOME are newly forwarded by this change.

## Validation

- Add focused spawn-environment tests for a set parent HOME and for the absent/empty-HOME fallback.
- Add a fixture command that compares parent and child home resolution and creates a bounded test path under a test HOME supplied by the test harness; assert it never targets `/.local`.
- Keep tests isolated from the developer's real home by setting the parent process HOME to a temporary fixture directory before spawning the child.
- Run focused delegate child, runner, orchestration, and continuation tests, then `npm run check`.
- During evaluation, compare home-path verifier failures and parent-side repeated validations against the report baseline, and record any unintended user-home mutations attributable to incorrect task behavior.

## Evaluation

- **Window:** After an approved merged implementation, until 20 delegate attempts have completed or 2026-08-16, whichever is later; include at least 5 read-only worktrees, 5 writable worktrees, and 3 tools that consume home-relative configuration or user-local paths.
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** Forward the parent's effective HOME at the delegate child-spawn boundary, retain the existing environment allowlist, and use Node's `homedir()` only when parent HOME is absent or empty; approved 2026-08-02.
- **Merged change:** —
- **Resolution:** pending evaluation
