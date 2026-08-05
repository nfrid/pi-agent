# HF-20260804: Delegate worktree installs leak pnpm links into the parent checkout

- **Status:** triaged
- **Observed date:** 2026-08-04
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Multi-phase TypeScript workspace migration using writable isolated delegate worktrees
- **Harness component:** Delegate worktree isolation and dependency environment
- **Route / attempt / outcome:** Writable Luna delegates completed and their branches were merged/dropped; later parent typechecking resolved workspace packages through a retired delegate worktree
- **Observed cost / rework:** Produced stale type errors and required a full frozen pnpm reinstall before final verification
- **Recurrence / confidence:** Observed twice in this task; high confidence
- **Ticket:** [HFM-20260805: Use project-native delegate worktree setup](../tickets/20260805-isolate-delegate-dependency-links.md)

## Behavior

A writable delegate worktree running workspace dependency commands left package-local pnpm links in the parent checkout resolving into the delegate worktree. Dropping that worktree did not repair those links.

## Impact

Parent checks can consume stale source or fail after delegate cleanup, undermining worktree isolation and making a correct patch appear type-invalid. The failure can also remain hidden when the stale source happens to typecheck.

## Evidence

After dropping the Phase 5 delegate branch, `pnpm exec tsc --noEmit --traceResolution` in the parent resolved `@pi-dashboard/protocol` to `.worktrees/phase-5-extension-contributions/packages/dashboard-protocol/src/index.ts`. The current parent source already contained additional status aliases, but TypeScript read the retired worktree and reported incompatible old types. `CI=true pnpm install --frozen-lockfile` recreated `node_modules`; the same package-local link then resolved to `../../../dashboard-protocol`, and the checks passed.

## Smallest improvement

Ensure writable delegate worktrees cannot rewrite dependency links used by the parent checkout, or automatically validate and repair parent workspace links when a delegate worktree is retired or dropped.
