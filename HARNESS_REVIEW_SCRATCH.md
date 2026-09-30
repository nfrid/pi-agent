# Harness improvement — scratch roadmap

## Resume here

- Mode: **batch D complete; next bounded audit pending**. Source fix `0018adcf`, parent test-path correction `3ead57a8`; 102 scoped tests and relevant types/Biome pass. No deployment, model evaluation C, wrapper/base migrations or broad lifecycle refactor authorized.
- Baseline: `868e113d` (2026-09-30). Checkout was clean before creating this file.
- Audit milestone and batch A complete. Test patch `a1898260`; aggregate exits 0 with **2,609 passing tests**. Batch B docs committed `7191321c`, focused contracts 54 pass. C remains approval-pending.
- No active delegates/background dependencies. Batch D source patch is task-owned staged-path selection (`--no-renames`) + explicit merged:false empty-delta result. No-op reset removed rather than adding machinery/restrictions.
- Child integration 45 tests/types/Biome/isolated package build pass. Parent scoped integration + package/tool/worktree consumer suites **102 tests pass**; log `/tmp/pi-harness-batch-d-tests.log` (background `a6b85f7b-e70b-4ac1-a751-b1b66096a904` completed exit0).
- Parent package/extension types and changed-file Biome/whitespace pass. Sequencer assertion checks real fixture path (`3ead57a8`). Package runtime build validated only in isolated workspace; parent dist/live services are not upgraded.
- Historical batch A: `baseline-contract-tests@3` left a reviewed patch but hit carried-scratch integration guards. Initial overlap refusal and absent net-neutral path commit failure preserved checkout; no partial merge landed.
- Recovery complete: owned roadmap committed `a8c82859`; `baseline-tests-clean@1` reproduced exact reviewed patch from a clean base (inputs only, no inherited history), then `delegate_changes` squash landed `a1898260` with only 2 test files. No manual merge/rebase or integrator code changes.
- Final aggregate background `522db068-fbf5-4440-ab77-176e8c72a4ce` **completed exit 0**; log `/tmp/pi-harness-batch-a-final-check.log`. No active background dependencies.
- Reviewed final test patch: same-context wake dedupe, retention across requests, no redispatch/extra durable wake-state append; required migration indexes/data/FKs preserved and intentionally removed writer index explicit.
- Async setup blocker resolved: child inherits `PI_DELEGATE_CHILD=1`; normal `scripts/clean-npm-env.mjs` strips it. Named async test passes using cleaned launcher; migration/repository 57 and wake 6 pass.
- Premature aggregate `5407c382-f6c5-4faa-8820-9454d9e4348a` ran old tests before successful integration and is not final validation. Use the final aggregate handle above.
- Parent independent post-integration async + wake suites: **36 tests pass**. Changed-file Biome and diff whitespace pass. No production behavior changed.
- Do not read auth/credential files or raw user sessions; do not deploy or restart services. Authorized writes: `packages/worktree-manager/src/integrate.ts`, relevant existing integration test files, and this scratch file.
- Preserve unrelated checkout changes. Full baseline already established in batch A; prefer scoped checks for subsequent localized work.
- After compaction, read this file and current todo state; use automatic delegate/background completion reports rather than polling.

## Agreed priorities and approach

1. Correctness/safety.
2. Harness effectiveness and task correctness.
3. Simplicity and authoritative ownership.
4. Measured performance/cost.
5. Usability/maintenance.

Default loop: bound scope → establish evidence → propose → approve → implement → verify → delete obsolete code → evaluate (keep/revise/revert/insufficient evidence).
Separate correctness fixes, behavior-preserving refactors, behavior changes, and optimization claims. File size alone does not justify refactoring. No new framework or tracking system. An audit with no justified changes is valid.
User reminder during batch D: do not add restrictions or performative safety for its own sake; avoid overengineering. Favor removing unnecessary/destructive steps over new guards or machinery. Cover concrete supported behavior with proportional regressions, not exhaustive hypothetical scenario matrices.

## Whole-system review order

| Area | Status | Scope |
|---|---|---|
| 0. Baseline and boundaries | Initial milestone complete | Current checks measured; ownership mapped at component level, not exhaustively audited |
| 1. Agent-facing harness | Bounded audit complete | No verified prompt/tool-exposure bug; doc drift and compaction evaluation gap identified |
| 2. Execution/orchestration | Carried-WIP audit/fix complete | Next suggested seam: task/todo ownership and ergonomics; remaining lifecycle/wakeup/remote-control reviews not started |
| 3. Tools/integrations | Not started | Web/search, image reads, argument validation, usage and smaller tools |
| 4. Shared contracts/backend | Not started | Protocol/domain, persistence/indexing, transports |
| 5. Presentation | Not started | Dashboard, activity rendering, TUI/themes/notifications |
| 6. Development/operations | Not started | Scripts, dependencies/builds/benchmarks, SDK updates, deployment/docs |

Verified correctness findings can move ahead. Review shared packages with their consumers. Larger coordinated refactors require evidence of a faulty boundary, understood consumers, regression coverage, and explicit migration/rollback requirements where applicable.

## Existing evidence and constraints

- `docs/refactor-audit-context.md`: completed architecture/hardening work, guardrails, older validation caveats. Revalidate applicability; do not reopen completed cuts or treat old failures as current.
- `docs/harness-behavior-evaluation.md`: deterministic/manual agent behavior cases and limited prior smoke comparisons. Behavioral correctness is distinct from cost/latency proxies.
- `docs/session-metrics.md`: privacy-safe offline metrics; pending evaluation is not proof of improvement.
- `docs/system-prompt.md`, `docs/delegation.md`, `docs/background-jobs.md`: supported agent-facing contracts.
- `docs/development-workflow.md`: shared-checkout and scoped-check hygiene.
- `docs/dashboard-deployment.md`: must be read/followed before any dashboard-affecting implementation/deployment.
- Feedback maintenance uses `.agents/feedback/`; this milestone does not authorize report triage, ticket edits, or implementation.

## Preliminary ownership map

- Pi-facing behavior: `extensions/`; shared extension runtime/UI: `extensions/shared/`.
- Prompt composition: `extensions/system-prompt/`; shared instructions: `instructions/agent/`.
- Delegation: `extensions/delegate/`; isolation support: `packages/worktree-manager/`.
- Process/background support: `extensions/background-terminals/` and delegate hosted execution use the dashboard process host; `packages/background-jobs/` owns its portable protocol. Delegate orchestration still owns workflow/wake policy; the host owns child processes. Caller path verified in `extensions/delegate/tool.ts:683` and `runner.ts:358`.
- Dashboard server/persistence/runtime/indexing: `apps/dashboard-server/`.
- Browser presentation: `apps/dashboard-web/`.
- Portable shared contracts/models: `packages/dashboard-protocol/`, `dashboard-domain/`, `dashboard-client/`, `activity-model/`, `extension-contributions/`.
- Usage/title support: `packages/codex-usage/`, `packages/session-title/` and corresponding extensions.
- Validation/development/measurements: `package.json`, `scripts/`, workspace manifests/configs.

## Current work and durable handles

- Aggregate baseline `c1e0e105-dc49-4181-be05-796fd7571080` completed exit 1; log `/tmp/pi-harness-baseline-868e113d.log`.
- Skipped workspace tests `2f95621d-c8ba-4183-90b1-13a098bf3d36` completed exit 1; log `/tmp/pi-harness-workspace-baseline-868e113d.log`.
- Read-only prompt/context audit `prompt-context-audit@1` completed: no verified code defect; successful-compaction evaluation remains missing; 24 focused tests pass.
- Read-only tools/routing audit `tool-routing-audit@1` completed: no verified exposure/validation bug; review-selector documentation omission confirmed; 4 focused files/64 tests pass. Both audits are continuable but no further child work is active.
- Parent: owns scratch file, validation baseline, verification of findings, prioritization and final proposals.

## Validation evidence

### Batch A final result (`a1898260`)

- `PATH="$PATH:/usr/sbin:/sbin" bun run check` exits **0**: guards, all typecheck scopes and Biome pass; extension/script **1,258 tests pass**, workspace **1,351 tests pass** (**2,609 total**, no failing tests).
- Parent independent async/wake **36 tests pass**; changed-file Biome and diff whitespace pass. Child migration/repository **57 tests pass**.
- Six pre-existing non-null assertion lint warnings and Node web-test `--localstorage-file` warnings remain non-fatal. No production builds/E2E/deployments/restarts/model evaluations performed for this test-only batch.
- Scratch is tracked (`a8c82859` plus final progress update); implementation squash contains exactly the two approved test paths.

### Batch B final result (`7191321c`)

- Corrected `docs/delegation.md`, `docs/dashboard.md`, `docs/dashboard-deployment.md` only: review-only incremental selector, current hosted-child ownership, restart/detach/cancel semantics, direct-spawn distinction.
- `node scripts/clean-npm-env.mjs bun x vitest run extensions/delegate/changes-tool.test.ts extensions/delegate/lifecycle.test.ts extensions/delegate/delegate-child.test.ts`: **54 tests pass**. Log `/tmp/pi-harness-batch-b-contracts.log`.
- Manual schema/caller/lifecycle contract comparison and `git diff --check` pass. No test/source/schema/deployment-command changes; no full check/build/browser E2E or deployment warranted for docs-only change.

### Batch D final result (`0018adcf` + `3ead57a8`)

- Core change: commit task-owned paths with an actual staged delta; use `--no-renames` so deletion/rename endpoints remain explicit. Empty delta returns merged:false with truthful unchanged/nothing-to-squash reason. Removed unnecessary no-op reset; no extra safety framework or restrictions.
- Before-fix real-Git carried-only deletion regression failed; final regression passes. Added cases directly cover observed bug and preservation of deletion/rename/no-op/staged ownership/WIP/stash behavior; existing overlap/conflict/commit-failure tests remain.
- Parent `node scripts/clean-npm-env.mjs bun x vitest run packages/worktree-manager/src extensions/delegate/integrate.test.ts extensions/delegate/changes-tool.test.ts extensions/delegate/worktree.test.ts`: **102 tests pass** (5 files); log `/tmp/pi-harness-batch-d-tests.log`.
- Package + extension typechecks, changed-file Biome and diff whitespace pass. Child isolated package build passes. No full check/build-all/browser E2E/deployment/service restart; parent package dist was not rebuilt, so running/default-export consumers are not claimed upgraded.
- Review refinements stayed within 2 files: staged/task ownership intersection, truthful no-op outcome, removal of needless destructive reset, correctly resolved fixture sequencer assertion. No generic concurrency mechanism or new API.

### Pre-implementation baseline (`868e113d`)

- Environment: Node `v25.8.0`, Bun `1.4.0`, Pi `0.99.1`. All runs use system-tool PATH as needed. Baseline HEAD was `868e113d`; scratch was initially untracked.
- `PATH="$PATH:/usr/sbin:/sbin" bun run check`: SDK/Node guards and all three typecheck scopes pass. Biome exits successfully with 6 non-null-assertion warnings in external-delivery tests. Extension/script tests: 1,257 pass, 1 fails (125 files). Aggregate stops before workspace tests.
- Failure: `extensions/delegate/async.test.ts:2033`, `admits one persisted queued wake after runtime recreation`. Exact focused rerun also fails (29 skipped); log `/tmp/pi-harness-wake-repro-868e113d.log`.
- `bun run workspace:test`: server 485 pass/1 fails (`src/migrations.test.ts:335`); all other workspaces pass. Per workspace pass counts: title 10, background jobs 9, activity-model 28, contributions 8, protocol 63, codex-usage 1, domain 75, worktree-manager 8, client 180, web 483. No browser E2E or model evaluations run.
- Prompt audit focused tests: 24 pass. Tool/routing audit focused tests: 64 pass across changes-tool, delegate, codemode/result-use, tool-argument-validation.
- Parent focused wake-delivery contract suite: 6 pass; log `/tmp/pi-harness-wake-contract-868e113d.log`. Parent isolated server migration rerun: same named index assertion fails; log `/tmp/pi-harness-migration-repro-868e113d.log`.
- No production builds, browser E2E, successful compaction, paid model evaluation, deployment or service restart performed. No performance/behavior improvement claims established.
- Earlier audit's aggregate `ajv` and migration-version caveats are historical, not reproduced by these current scoped commands. Current aggregate stops sooner, so it does not independently verify the old aggregate-only `ajv` case.

## Findings / proposals

### F1 — Current tests disagree with intentional contract changes (verified failures)

- Wake integration test expects an admitted result to disappear on the next context transformation. `wake-delivery.ts:305–336` intentionally preserves the entered result across requests; `wake-delivery.test.ts:96–139` tests retained provider-visible evidence and one acknowledgement. Commit `3ac38472` changed this intentionally but did not touch the async test. Current evidence points to stale integration expectations, not duplicate dispatch.
- Server migration test compares all indexes before/after all migrations. It expects `active_writer_per_checkout`, but migration at `repositories/migrations.ts:933` intentionally drops it; commit `85ca6e22` enables parallel runs in a shared checkout.
- Proposed batch: reconcile these tests with supported behavior; preserve assertions for single delivery/acknowledgement, stale/foreign rejection, dependent row/index integrity, and named removed-index behavior. No production behavior reversal simply to green the suite. **Implemented/verified in batch A**. Focused pre-fix migration rerun reproduced exactly; migration 24 (`allow-parallel-checkout-writers`) and commit `85ca6e22` explicitly support the changed contract.

### F2 — Successful compaction behavior remains unevaluated (evaluation gap)

- `docs/harness-behavior-evaluation.md` case 3 specifies decision/non-goal retention, but previous comparison records `Nothing to compact (session too small)` and marks compaction blocked/not exercised.
- Proposed batch: make a disposable fixture reliably reach compaction; require actual successful compaction and subsequent constraint retention before changing policy. No auth-file access, real-session ingestion, or broad prompt rewrite. Model runs require normal harness-managed credentials and explicit evaluation scope/cost. Approval pending.

### F3 — Agent-facing and operational documentation drift (verified)

- `docs/delegation.md:151` omits review-only `incremental`; `extensions/delegate/changes-tool.ts:32–36` documents it as task commits not represented in current parent HEAD by patch identity. Current full recorded-range review remains the default. Document the selector without changing behavior.
- `docs/dashboard.md:245–246` says delegate migration to durable jobs is pending. The current async tool launch explicitly sets `hosted: true` (`extensions/delegate/tool.ts:683`); `runner.ts:358` invokes `runHostedDelegateChild`. `docs/background-jobs.md` already warns process-host restarts terminate hosted children. Correct ownership docs while distinguishing hosted production paths from directly spawned runner/test paths; do not claim every invocation is hosted.
- Impact: missing useful review affordance and contradictory process/restart ownership. **Corrected/verified in batch B (`7191321c`)**; no behavior changes.

### F4 — Squash path list includes an absent carried-only deletion (verified)

- `packages/worktree-manager/src/integrate.ts:886–897` dirty/incoming overlap guard is intentional and ownership-safe. Keep it.
- `taskPaths()` unions per-commit changed paths. At `integrate.ts:917–925`, squash applies unintegrated commits with `cherry-pick --no-commit` then passes that original incoming path list to `git commit --only`.
- A file that exists only in the carried snapshot and is deleted by the task is absent from parent HEAD and the resulting index, but remains in incoming paths. A task that also adds/updates a real file can apply successfully then fail commit with absent-path pathspec error.
- Evidence: observed in batch A and reproduced by child with disposable repo using real integrator. Failure returned merged:false, rolled back HEAD/index/worktree and left pre-existing stash intact. Cumulative-base wrapper not established as the cause.
- Existing portable (2) and extension (35) tests lack this carried-only deletion squash case. Parent independently reran both: **37 pass**; log `/tmp/pi-harness-integration-audit-tests.log`.
- **Implemented/verified in batch D.** Effective staged delta is intersected with task-owned paths; deletions/renames preserved. Existing ownership guard and rollback retained. No-op removes destructive cleanup rather than adding restrictions.

## Proposed batches and acceptance

### A. Restore trustworthy test baseline — complete

- Scope: `extensions/delegate/async.test.ts` restored-wake case and `apps/dashboard-server/src/migrations.test.ts` v10 migration case; minimally strengthen related assertions if needed.
- Preserve retained result content across successive provider contexts; prove no redispatch/re-acknowledgement. Preserve same-context deduplication and stale/foreign-message protections through existing coverage.
- Assert migration 24's deliberate removed index while retaining required surviving indexes, dependent data and foreign-key integrity. Do not merely weaken all index assertions or remove failed tests.
- Validate focused wake/async and migration/repository suites, scoped types/Biome; rerun aggregate check for cross-cutting baseline restoration. If a real defect emerges, stop and update proposal rather than reverse supported contracts.
- Approval/result: **approved by user; integrated as `a1898260`; kept**. Final aggregate exits 0 (2,609 tests). Focused parent async/wake 36 tests and changed-file Biome pass; isolated migration/repository 57 tests pass.

### B. Align supported-interface and process ownership docs — complete

- Scope: the two F3 omissions/contradictions only. No lifecycle migration, SDK shim removal, new API or service restart.
- Acceptance: optional incremental review and unchanged default accurately described; hosted delegate ownership/restart implications match caller/runner paths; direct-spawn paths not mislabeled.
- Approval/result: **approved; committed `7191321c`; kept**. Schema/call-site comparison, 54 focused contract tests and diff whitespace pass. Also corrected the same pending-migration claim in deployment guidance; no operational commands changed.

### C. Close successful-compaction evaluation gap

- Prepare a reproducible disposable fixture, pinned harness/config/model/thinking and bounded run budget. Keep case decision/non-goal in conversation rather than re-reading them from a progress file, otherwise the fixture would test a different mechanism.
- Require a successful compact response and correct continuation preserving both constraints; blocked/setup failure is not a pass. Record transcripts/results without credentials or production state.
- Do not change prompt/routing/compaction code until evidence warrants it. Single trials are smoke evidence, not general cost/quality claims. Approval: pending.

### D. Commit the effective task delta during squash — complete

- Scope: portable integrator squash commit-path selection in `packages/worktree-manager/src/integrate.ts`, regression at its real-Git integration-test boundary (existing extension suite is acceptable). No wrapper/base migration, new API, broad cleanup or weakened dirty-overlap guard.
- Candidate remedy: derive staged changed paths after no-commit cherry-pick and restrict commit to the task-owned effective delta. Preserve normal tracked-file deletions. Handle an empty effective delta explicitly with a safe, clear no-op outcome rather than an accidental broad commit.
- Acceptance: carried-only deletion plus actual edit/addition squashes to one correct parent-authored commit; absent file is not introduced; tracked deletion still lands; add-then-delete/net-neutral task paths do not poison pathspecs; no effective delta creates no empty/spurious commit.
- Ownership/safety: dirty task-path overlap still refuses; unrelated staged/unstaged/untracked files and pre-existing stash stack are preserved; genuine conflicts/commit failures restore HEAD/index/worktree and operation state. Existing cumulative/patch-identity behavior remains unchanged.
- Validation: reproduce regression before fix; focused real-Git integration suites, package + extension typechecks as needed, changed-file Biome, exact commit/diff assertions and rollback checks. No production deployment or full harness rewrite.
- Approval/result: **approved; integrated `0018adcf` + test correction `3ead57a8`; kept**. 102 scoped tests/types/Biome pass; isolated package build passes. No runtime API/state model or wrapper/base changes. Live activation/deployment remains unperformed.

## Deliberately unchanged

- Canonical system-prompt owner, composition order, intentional rejection of direct prompt inputs and documented hook precedence.
- Optional hybrid codemode with native `models.*` disabled; child tool allowlists and explicit skills.
- No broad delegate decomposition, protocol/storage migration, dynamic plugin/state framework, feedback triage or performance claims.
- Six existing lint warnings are recorded but not used to widen the first batch.
- Next structural audit after agreed batches: bounded execution/orchestration review, choosing one lifecycle/ownership seam rather than all delegate files.

## Next decision

Batch D complete. Recommend next a read-only task/todo subsystem pass (`extensions/tasks/`): state/contract ownership, duplication, coupling and tool ergonomics, with emphasis on simplification/deletion rather than stricter policy. Require evidence before proposing edits. Compaction evaluation C and live activation/deployment remain separate and approval-pending.

Record for later execution/operations audit: carried untracked parent progress file made test-only integration conflict; deleting that carried artifact led to absent-path `commit --only` failure. Both attempts aborted safely. Recovery was a tracked roadmap and a clean-base child reproduction; no manual merge or integrator changes. Also use cleaned test launcher inside delegate environments to strip `PI_DELEGATE_CHILD`. The verified absent-path defect is now authorized as batch D; broader runtime changes and feedback triage are not authorized. B is approved documentation work; C is a separate evaluation requiring approval of a bounded model-run budget. Scratch is being versioned so future clean-base delegates do not carry an untracked copy that collides with parent progress updates.
