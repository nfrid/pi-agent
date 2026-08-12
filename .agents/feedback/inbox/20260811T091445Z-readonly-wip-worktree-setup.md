# HF-20260811: Read-only WIP delegation cannot snapshot a multi-repository workspace

- **Status:** duplicate
- **Observed date:** 2026-08-11
- **Source cwd/repo:** `/Users/nfrid/job` multi-repository workspace
- **Task shape:** Independent read-only regression review of uncommitted changes in two product repositories
- **Harness component:** Delegate read-only worktree isolation and WIP snapshot setup
- **Route / attempt / outcome:** `luna-xhigh`, `isolation: worktree`, `from: wip`; setup failed before launch
- **Observed cost / rework:** The independent review had to be retried in the shared checkout, losing isolation from concurrent parent edits
- **Recurrence / confidence:** Observed once in this session; high confidence in the failure, unknown confidence in its underlying cause
- **Ticket:** [HFM-20260806: Report actionable delegate lifecycle failures](../tickets/20260806-report-actionable-delegate-lifecycle-failures.md)

## Behavior

A fresh read-only delegate requested from the workspace root with `isolation: worktree` and `from: wip` failed before launch while Pi attempted to create its carried-WIP snapshot commit. No child ran and no snapshot was retained.

## Impact

Multi-repository review tasks cannot reliably obtain an isolated view of current uncommitted product changes. Falling back to `isolation: shared` makes the review susceptible to parent edits occurring during the run and weakens its independence.

## Evidence

- Workspace: `/Users/nfrid/job`, whose root coordinates multiple product repositories.
- Pi reported `Delegate setup failed before launch: Worktree setup failed while running the repository checkout/setup hooks`.
- The reported failing operation was a harness-created `git ... commit --no-verify --message Carried uncommitted parent work` inside the generated review worktree.
- The result did not include Git stderr identifying which path or repository state prevented the snapshot.
- Retrying the same review as read-only `isolation: shared` launched successfully.
- The exact cause is unknown; multi-repository or nested-repository WIP handling is an assumption, not an established fact.

## Smallest improvement

Include the failing Git stderr and affected path in setup failures, and preflight whether the current WIP can be represented in an isolated snapshot. If this workspace shape is unsupported, fail with a specific explanation and recommended isolation mode before creating the worktree.
