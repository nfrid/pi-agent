# HF-20260809: Writable delegate worktrees cannot run requested workspace validation

- **Status:** duplicate
- **Observed date:** 2026-08-09
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Several isolated dashboard implementation delegates with explicit test, typecheck, and build acceptance commands.
- **Harness component:** Writable `delegate` worktree isolation and dependency availability
- **Route / attempt / outcome:** `luna-high` and `luna-medium` writable worktree runs implemented and committed their changes, but repeatedly reported that requested tests/typecheck could not run because workspace dependencies or built workspace package entries were unavailable.
- **Observed cost / rework:** The parent had to integrate each branch before running authoritative checks, reducing pre-merge confidence and requiring additional review/fix cycles.
- **Recurrence / confidence:** Observed across three writable delegate runs in this task; high confidence.
- **Ticket:** [HFM-20260805: Use project-native delegate worktree setup](../tickets/20260805-isolate-delegate-dependency-links.md)

## Behavior

Fresh writable delegate worktrees contained source and lockfiles but were not ready to execute the repository's normal workspace validation commands. Delegates reported unresolved external modules and missing built workspace package entrypoints rather than the requested test/typecheck outcomes.

## Impact

Writable delegates can return committed implementations without proving their stated acceptance criteria. The parent must merge or manually bootstrap a separate environment before discovering compile/test failures, which weakens isolation and increases integration rework for otherwise well-bounded delegated tickets.

## Evidence

- A server implementation delegate reported HTTP tests, typecheck, and workspace build unavailable because `ws`, `fastify`, and workspace package declarations could not resolve.
- A web implementation delegate reported web tests/typecheck unavailable because Vite/Tailwind dependencies were missing.
- A follow-up server delegate again could run only a limited test after dependency resolution failures.
- The parent subsequently ran the same project commands successfully from a dependency-provisioned isolated deployment worktree.

## Smallest improvement

Provide an opt-in dependency-ready writable worktree mode that safely reuses or bootstraps the repository's package-manager environment before the child starts. At minimum, expose a standard setup command or capability flag in the delegate task context so acceptance commands can run without merging first or risking parent-worktree dependency links.
