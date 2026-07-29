# HFM-20260729: Detach and refresh read-only review snapshots

- **Status:** evaluation-pending
- **Approval:** approved 2026-07-29
- **Created:** 2026-07-29
- **Source reports:** [HF-20260729: Read-only review worktrees are presented as integration branches](../inbox/20260729T125701Z-read-only-review-branch-cleanup.md)

<!-- Proposal and implementation approval are separate decisions. This ticket was approved only for the implementation recorded below. -->

## Problem

A successful isolated read-only delegate with no task-authored changes is presented and retained like a writable implementation branch. Its completion tells the parent to review and merge a branch that has nothing to integrate, while removing the checkout requires an apparently destructive forced drop.

The deeper issue is that the harness couples two lifetimes: the child conversation is resumable only while its original worktree remains, and the worktree is retained as though resumability made it integration work. This prevents automatic cleanup and gives a continuation no explicit way to retain its review context while checking a newer parent snapshot.

## Baseline

One `luna-high` review using `allowWrites: false`, `isolation: worktree`, and `from: wip` completed successfully with no changes. Its completion still emitted `Branch`, `Worktree`, and `Integrate with` fields, and the parent used `delegate_branches drop --force` to remove it.

The behavior is deterministic in the current source:

- `finalizeWorktreeRun` settles every prepared worktree through `finishWorktree` and leaves its checkout and branch in place.
- `prepareRun` in `extensions/delegate/output.ts` emits review/merge instructions for every `run.worktree`.
- `worktreeLines` in `extensions/delegate/render-utils.ts` does the same without considering `allowWrites` or `hasWork`.
- `preflightDelegateContinuation` binds a worktree continuation to its persisted worktree ID and fails if that checkout record is unavailable.
- `delegate_branches drop` requires `force` whenever Git classifies the branch as unmerged, even when the record has no task-authored work. A WIP review branch can be unmerged solely because it contains the harness-created carry commit.

A continued reviewer on the retained checkout sees the original source, not parent fixes made after the review. That is useful for clarification but cannot validate changed code. The current API offers only a fresh delegate for the new source state, discarding the reviewer's context. No existing ticket covers this lifecycle; the other read-only worktree ticket concerns dependency availability.

## Hypothesis

If read-only child context is persisted independently from its physical checkout, then the harness can retire every successfully settled, unchanged review checkout without losing resumability. If continuation explicitly chooses either the original snapshot or current parent `wip`/`head`, then agents can distinguish same-evidence clarification, targeted fix verification, and independent fresh review without inferring intent from task prose.

This should eliminate misleading integration prompts and retained clean review checkouts while making targeted review iterations cheaper. Fresh delegates remain the independent-review path and should still be used when independence or broad regression discovery matters.

## Guardrails

- Snapshot choice must be explicit API semantics, never inferred from natural-language task text.
- Omitting the refresh option on a continuation must preserve same-snapshot behavior.
- Refreshing a snapshot is allowed only for read-only worktree continuations; never reset, replace, or discard a writable delegate's branch.
- Create a replacement checkout before switching the session record; a failed refresh must leave the prior resumable snapshot intact.
- Tell the child when its workspace snapshot changed and require it to re-read relevant files rather than trust stale source observations.
- Keep failed, aborted, timed-out, lifecycle-error, or unexpectedly changed worktrees available for diagnosis; automatic retirement applies only to successfully settled read-only runs with no task-authored work.
- A carried parent WIP commit is snapshot material, not task-authored integration work.
- Preserve `from: head` isolation: current uncommitted parent changes must not enter a HEAD refresh.
- Reuse existing bounded WIP carry, ignored-file, and dependency-link policies; do not install dependencies or broaden copied secrets.
- Do not claim a context-preserving refreshed review is independent evidence. A fresh delegate remains required when independent review is requested.
- Do not add automatic expiry, a general snapshot database, or unrelated writable-worktree lifecycle changes.

## Options considered

1. **Accurate wording plus manual drop:** Omit integration instructions and allow a clean read-only branch to be dropped without `force`. This is small but retains every checkout solely for possible continuation and cannot reuse review context against fixes.
2. **Delete clean read-only worktrees and invalidate continuation:** Removes resources but breaks useful clarification and targeted verification workflows while still advertising a continuation token.
3. **Detach checkout state from child context and support explicit snapshot selection:** Automatically retire clean checkouts, rehydrate the original snapshot for same-state continuation, and create a current `wip` or `head` snapshot for targeted fix verification. This requires bounded lifecycle work but resolves the coupling rather than documenting it.
4. **Always require a fresh reviewer after fixes:** Maximizes independence but discards useful finding context and repeats investigation even when the immediate goal is only to close exact findings.

## Recommendation

Implement option 3. Treat successfully settled, unchanged read-only worktrees as resumable snapshots rather than integration branches:

- Remove their physical checkout automatically after each run while retaining the minimum Git reference and session metadata needed to recreate the exact snapshot.
- A continuation with no refresh request rehydrates that original snapshot.
- Add one explicit continuation-only selector for refreshing from the parent repository's current `wip` or `head`. The exact parameter name may follow the established delegate schema, but omission, current-WIP refresh, and current-HEAD refresh must be distinct values.
- Build refreshed state in a replacement worktree, atomically repoint the read-only session after successful preparation, then retire the superseded snapshot resources.
- Mark the refreshed child context with old/new snapshot identity and a warning to re-read source.
- Present read-only snapshot lifecycle and continuation guidance, never writable branch review/merge instructions.
- Keep fresh delegation documented as the independent regression-review path.

Prefer a lightweight retained Git ref plus on-demand checkout over keeping a physical worktree. Do not mutate the old checkout in place: replacement makes failure atomic and avoids mixing old carry commits with current parent WIP.

## Scope

- **In:** Successful unchanged read-only worktree retirement; lightweight same-snapshot retention and rehydration; explicit current-WIP/current-HEAD refresh for read-only continuations; atomic session repointing; snapshot-aware output and prompt guidance; cleanup of superseded resources; focused lifecycle tests.
- **Out:** Writable continuation refresh; automatic session expiry; arbitrary historical commit selection; merging snapshots; changing child model/context; claiming refreshed continuation is independent review; general worktree storage redesign beyond what this lifecycle needs.

## Acceptance criteria

- [x] After a successful read-only worktree run with no task-authored changes or settlement error, its physical checkout is automatically removed and no integration branch is presented to the parent.
- [x] The child session remains continuable after checkout retirement.
- [x] A continuation with no refresh selector recreates the exact original source snapshot, including WIP carry semantics and the existing allowed dependency/file projections.
- [x] A read-only continuation can explicitly refresh from the parent repository's current WIP and sees fixes made since the previous run.
- [x] A read-only continuation can explicitly refresh from current HEAD without receiving uncommitted parent changes.
- [x] A refreshed child receives an unambiguous notice that its source snapshot changed and that prior file observations may be stale.
- [x] Refresh preparation is atomic: if replacement preparation fails, the session can still continue from its previous snapshot and no partial replacement becomes authoritative.
- [x] Superseded checkout and snapshot resources are cleaned after a successful refresh; the current lightweight snapshot remains explicitly droppable without `force` when it contains no task-authored work.
- [x] Writable continuations reject refresh requests and retain existing branch review, merge, recovery, and forced-drop behavior.
- [x] Failed, aborted, timed-out, lifecycle-error, or unexpectedly changed read-only worktrees are retained with diagnostic guidance rather than automatically deleted.
- [x] Parent handoffs and expanded rendering for retired read-only reviews omit `delegate_branches review`/`merge` instructions and explain same-snapshot continuation versus refreshed targeted verification.
- [x] Delegate guidance identifies a fresh delegate—not refreshed continuation—as the independent regression-review path.

## Validation

- Add lifecycle fixtures for automatic checkout retirement and exact same-snapshot rehydration after a successful unchanged read-only run.
- Test current-WIP refresh with tracked and untracked fixes and current-HEAD refresh with those WIP changes excluded.
- Assert dependency links and allowed ignored-file projections are recreated but never committed or retained after checkout retirement.
- Inject replacement-preparation failures and assert the old snapshot/session mapping remains usable with no leaked authoritative record.
- Test repeated retire/rehydrate and retire/refresh cycles, including cleanup of superseded worktrees, refs, and records.
- Add negative cases for writable refresh, unexpected read-only changes, settlement errors, failed, aborted, and timed-out runs.
- Add output/render tests proving clean read-only reviews have snapshot guidance without branch integration instructions, while writable output remains unchanged.
- Add orchestration/schema tests for omitted, WIP-refresh, and HEAD-refresh continuation semantics and for clear invalid combinations.
- Run focused delegate lifecycle, worktree, output, render, schema, and orchestration tests, then `npm run check`.

## Evaluation

- **Window:** Started 2026-07-29; ends after 20 successful clean read-only review runs including at least 5 same-snapshot continuations and 5 refreshed continuations, or 2026-08-19, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare against the baseline of one retained clean checkout, one misleading integration prompt, and one forced manual drop in one observed review. Track retained clean checkouts, misleading integration actions, continuation restoration failures, refresh failures, leaked snapshot resources, and cases where agents incorrectly describe refreshed continuation as independent review.

### Observations

- **2026-07-29:** A disposable untracked WIP package was reviewed in a real read-only worktree. The checkout retired automatically, the handoff used snapshot guidance without integration instructions, and a same-snapshot continuation restored the exact source and dependency projection. This accounts for 2 successful clean runs, including 1 same-snapshot continuation.
- **2026-07-29:** The first live WIP refresh failed before child execution because the persisted Pi session header still named the retired checkout. The diagnostic worktree was retained and later removed after inspection. Follow-up `4fe3984` synchronizes the persisted session cwd and adds the retired → same-snapshot → WIP-refresh regression case; focused lifecycle/worktree tests passed (31 tests), including HEAD exclusion. A refreshed live run must still be repeated after the extension runtime reloads, so the refreshed-continuation count remains 0.

## Implementation and resolution

- **Approved implementation:** Detach successful unchanged read-only child context from its physical checkout; retain and rehydrate the exact snapshot by default; add an explicit atomic refresh to current parent WIP or HEAD for read-only continuations; preserve writable and diagnostic-retention behavior; update lifecycle guidance and focused tests. Approved 2026-07-29.
- **Merged change:** `ddb4db1` (implementation `cef9534`, fixes `294f30f`, `87cf855`, `4c7ebf5`); evaluation fix `4fe3984`
- **Resolution:** pending evaluation
