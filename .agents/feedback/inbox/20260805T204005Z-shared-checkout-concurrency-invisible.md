# HF-20260805: Concurrent Pi sessions in one checkout are invisible to each other

- **Status:** parked
- **Observed date:** 2026-08-05
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Implement, test, commit, and deploy dashboard changes while another Pi session independently changed overlapping files in the same checkout.
- **Harness component:** Runtime/session workspace coordination
- **Route / attempt / outcome:** Parent session on `gpt-5.6-sol`; completed after manually separating owned hunks and building the intended commit in a detached worktree.
- **Observed cost / rework:** Repeated status/diff inspection, partial-hunk staging, isolated-port test reruns, and an isolated deployment build were required to avoid committing or deploying another session's work.
- **Recurrence / confidence:** Observed directly once with several overlapping files; likely recurrent whenever multiple writable Pi sessions target the same repository. High confidence.
- **Ticket:** [HFM-20260806: Warn concurrent shared-checkout writers](../tickets/20260806-warn-concurrent-shared-checkout-writers.md)

## Behavior

Two writable Pi sessions operated in the same checkout without either session receiving an ownership or overlap warning. During the task, `HEAD` advanced and unrelated edits appeared in files already being modified by the current session. The harness exposed the resulting filesystem state but did not identify it as another active Pi session's work.

## Impact

An agent can accidentally format, stage, commit, test, or deploy another session's incomplete changes. Avoiding that required manual process inspection and patch-level separation, and validation in the shared tree no longer proved the intended commit in isolation.

## Evidence

- The task baseline was commit `a0681e9`; while verification was running, `HEAD` advanced through `2d99fd6`, `6bac595`, and `81f5fc6`.
- Concurrent edits appeared in `apps/dashboard-web/e2e/dashboard.spec.ts`, `apps/dashboard-web/src/entities/transcript.tsx`, and `apps/dashboard-web/src/styles.css`, which overlapped the current task's files.
- The current session had to stage selected hunks and inspect `git diff --cached` to keep its commit isolated.
- The intended dashboard commit was built in a detached worktree because building the shared checkout would have included unrelated uncommitted changes.

## Smallest improvement

When a writable Pi session starts or writes in a repository already used by another active writable Pi session, show a warning naming the other session and any overlapping changed paths. Re-notify when `HEAD` advances or new overlapping modifications appear during the run.
