# HFM-20260806: Warn concurrent shared-checkout writers

- **Status:** parked
- **Approval:** not approved
- **Created:** 2026-08-06
- **Source reports:** [HF-20260805: Concurrent Pi sessions in one checkout are invisible to each other](../inbox/20260805T204005Z-shared-checkout-concurrency-invisible.md)
- **Decision:** Parked 2026-08-06 as disproportionate after one incident; use repository guidance requiring a separate worktree when another writer is known or concurrent changes become apparent, and revisit harness detection only after repeated incidents despite that guidance

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

Multiple writable Pi sessions can operate in the same checkout without identifying each other. Filesystem and Git changes are visible, but the harness does not distinguish another active session's work from the current session's work. An agent can therefore format, stage, test, commit, or deploy overlapping changes accidentally.

## Baseline

In the reported episode, the session began at `a0681e9`, then observed `HEAD` advance through `2d99fd6`, `6bac595`, and `81f5fc6` while concurrent edits appeared in three paths the session was also changing: `apps/dashboard-web/e2e/dashboard.spec.ts`, `apps/dashboard-web/src/entities/transcript.tsx`, and `apps/dashboard-web/src/styles.css`. Avoiding contamination required repeated status and diff inspection, selected-hunk staging, isolated-port tests, and a detached-worktree deployment build. No existing feedback ticket covers coordination between independent writable Pi sessions in one shared checkout; delegate worktree integration and branch inventory tickets address isolated child worktrees instead.

## Hypothesis

If the harness records active writable sessions by repository and checkout, warns when another writable session shares that checkout, and re-warns when their changed paths overlap or the checkout's `HEAD` advances unexpectedly, then agents will detect concurrent ownership hazards before staging or deployment. This is falsified if an overlap or external `HEAD` advance remains undisclosed until integration, or routine single-session and isolated-worktree tasks receive warnings.

## Guardrails

- Keep coordination advisory: do not lock files, block commands, reserve paths, stage changes, or terminate another session.
- Expire stale or crashed session records so warnings do not become permanent.
- Identify sessions and overlapping path names without exposing prompts, transcript content, diffs, or file contents.
- Distinguish the same checkout from separate Git worktrees; isolated writable delegates must not be reported as shared-checkout collisions.
- Do not infer ownership of pre-existing changes when no active session record supports it.
- Preserve ordinary Git behavior and support non-Pi external commits by describing those only as unexpected `HEAD` movement.

## Options considered

1. **Repository-scoped active-session registry with advisory change detection:** Provides timely and attributable warnings with bounded metadata, but requires stale-record lifecycle handling and path comparison.
2. **Warn only when `HEAD` or `git status` changes:** Simpler, but cannot distinguish another Pi session, misses simultaneous edits before a status boundary, and creates noise from the current session's own commands.
3. **Enforce one writable session or automatic per-session worktrees:** Strong isolation, but changes normal workspace semantics and blocks legitimate collaboration beyond the reported need.

## Recommendation

Implement option 1 narrowly. Register writable sessions against the repository identity and checkout path, warn both sessions when they share a checkout, and compare each session's baseline plus known changed paths at bounded lifecycle boundaries. Re-notify only for a new overlapping path set or unexpected `HEAD` advance so persistent conditions do not flood context.

## Scope

- **In:** Writable-session registration and expiry; repository/checkout identity; startup warning; changed-path overlap and unexpected-`HEAD` warnings; bounded deduplication; tests for concurrent sessions and worktrees.
- **Out:** File locks; path reservations; automatic worktree creation; staging or commit policy; merge automation; content inspection; external process attribution; a general collaboration service.

## Acceptance criteria

- [ ] Starting a second writable Pi session in the same checkout warns both active sessions and identifies the other session with bounded non-content metadata.
- [ ] A new path overlap produces a warning naming the overlapping paths before the harness presents staging, commit, or deployment as safe.
- [ ] An unexpected `HEAD` advance from the recorded session baseline produces a distinct warning even when changed paths do not overlap.
- [ ] Repeated checks of an unchanged collision do not emit duplicate warnings; a materially new overlap or `HEAD` advance does.
- [ ] Read-only sessions, separate Git worktrees, single-session work, and expired session records do not produce shared-checkout warnings.
- [ ] Abruptly terminated sessions age out without manual cleanup or permanent blockage.
- [ ] Warnings contain no prompt, transcript, diff, or file-content data.

## Validation

Add fixtures for two writable sessions in one checkout, non-overlapping and overlapping edits, multiple successive overlaps, external commits, normal same-session commits, clean shutdown, crashed/stale owners, read-only sessions, and sibling Git worktrees. Assert warning deduplication and metadata boundaries, then run focused lifecycle tests and `npm run check`.

## Evaluation

- **Window:** After an approved merge, the first 10 episodes with at least two concurrent writable Pi sessions in one repository, or 2026-10-15, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of one undetected shared-checkout collision requiring hunk isolation and detached-worktree validation. Keep only if every shared-checkout overlap and unexpected `HEAD` advance is warned before staging or deployment, no separate-worktree episode is mislabeled, and no stale record requires manual recovery.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
