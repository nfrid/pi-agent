# HF-20260804: Dropping delegate worktrees breaks parent workspace dependencies

- **Status:** new
- **Observed date:** 2026-08-04
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Multi-package TypeScript refactor using writable isolated delegates, branch review/merge, and parent-side verification
- **Harness component:** Delegate worktree isolation and branch cleanup
- **Route / attempt / outcome:** Writable `luna-xhigh`/`luna-high` worktree delegates completed successfully; after `delegate_branches drop`, parent verification failed because root dependency symlinks targeted the deleted delegate worktree
- **Observed cost / rework:** Parent had to recreate the entire workspace `node_modules` repeatedly with `CI=true pnpm install --frozen-lockfile` before tests could run
- **Recurrence / confidence:** Observed more than once in this session; high confidence
- **Ticket:** —

## Behavior

A delegate dependency install changed the parent checkout's root `node_modules` links to point into the delegate checkout. Dropping that delegate worktree deleted the link targets and left the parent checkout unable to execute workspace tools.

## Impact

Successful isolated delegate work can make the parent environment unusable at the exact point when branch review and verification should begin. Cleanup is unexpectedly destructive across the isolation boundary, and repeated reinstalls add time and can obscure whether a verifier failed because of source code or harness lifecycle state.

## Evidence

After dropping the completed contracts delegate worktree, `pnpm --filter @pi-dashboard/protocol test` failed with:

`Cannot find module '/Users/nfrid/.pi/agent/node_modules/vitest/vitest.mjs'`

Inspection showed root `node_modules/vitest` linked through:

`../.worktrees/contracts-and-reducers-implementation/node_modules/.pnpm/.../node_modules/vitest`

The target worktree had just been removed by `delegate_branches drop`. `CI=true pnpm install --frozen-lockfile` restored the parent environment. The same failure recurred after later delegate worktree cleanup.

## Smallest improvement

Ensure dependency installation inside an isolated delegate cannot retarget the parent checkout's root `node_modules` links. At minimum, detect parent links into a worktree before dropping it and preserve or repair the parent dependency installation during cleanup.
