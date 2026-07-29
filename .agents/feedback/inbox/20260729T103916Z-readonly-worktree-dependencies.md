# HF-20260729: Read-only review worktrees cannot run dependency-backed checks

- **Status:** triaged
- **Observed date:** 2026-07-29
- **Source cwd/repo:** `/Users/nfrid/job` meta-repository
- **Task shape:** Isolated security reviews of a new Bun/TypeScript package
- **Harness component:** Read-only worktree delegation environment
- **Route / attempt / outcome:** Read-only `terra-max`, `terra-high`, and `luna-high` review delegates received WIP source snapshots but not ignored `node_modules`; reviewers reported that full checks could not run because `tsc` was unavailable.
- **Observed cost / rework:** Reviewers could run some Bun tests but could not independently reproduce the package typecheck/check gate; the parent had to supply that validation separately.
- **Recurrence / confidence:** Observed across multiple isolated review delegates in this session; high confidence and likely recurrent for dependency-backed repositories.
- **Ticket:** [HFM-20260729: Link dependencies for carried WIP packages](../tickets/20260729-link-carried-wip-package-dependencies.md)

## Behavior

A read-only worktree snapshot contains task source but not ignored installed dependencies. Because the task is read-only, the reviewer does not establish dependencies in its checkout, leaving repository check commands partially unavailable even when they work in the parent checkout.

## Impact

Fresh isolated reviews lose an important verification capability precisely where independent validation is valuable. Reports may contain avoidable “check unavailable” caveats or rely only on narrower tests.

## Evidence

Multiple review results stated that `kibana-logs bun run check` could not run because `tsc` was unavailable. In the parent checkout, `bun run check` completed successfully using the installed dependencies.

## Smallest improvement

Provide read-only delegates a safe dependency-backed execution path, such as a shared immutable package cache/install projection or an explicitly ephemeral dependency setup that does not grant source-write capability.
