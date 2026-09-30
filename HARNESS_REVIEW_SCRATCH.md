# Harness improvement — scratch roadmap

## Resume here

- Mode: **complete for this incremental pass, including the explicit feedback-inspector addition**. Routine local continuation used without repeated approval prompts. Representative major-area coverage, not exhaustive line-by-line auditing. Preserve APIs/defaults/order/contracts; prioritize simplification rather than new restrictions. No production activation/deployment/restarts performed or authorized. Bounded compaction smoke recorded with caveats; no further model runs planned.
- Baseline: `868e113d` (2026-09-30). Checkout was clean before creating this file.
- Audit milestone and batch A complete. Test patch `a1898260`; aggregate exits 0 with **2,609 passing tests**. Batch B docs committed `7191321c`, focused contracts 54 pass. C native retry successfully compacted and retained both facts; partial protocol compliance (automatic mechanisms not disabled), not full-harness parity.
- E completed `c7067a17`: common task result/stats assembly, explicit registrations, corrected docs; 35 tests/types/Biome pass. Runtime deletion `d12271e8`: unused hasPending method removed, count-based API authoritative.
- Operations `36ae91f6`: root test script forwarded paths/options incorrectly; regression failed before fix, actual Bun child-env invocation now passes37 scoped tests. Simpler script keeps Node guard/environment cleanup; root/workflow guidance updated.
- tools-simplify-pass@1 (60 focused tests), dashboard-boundaries-pass@1 and small-ui-pass@1 completed without justified changes. Current native SDK0.99.1 still lacks precise APIs needed to remove existing activity/skill/steering fallbacks; preserve them.
- C `compaction-smoke@2` complete: native manual compact succeeded (64,219 → estimated21,610 tokens), summary/continuation preserve `buildReport`/no persistence; parent verified raw correlated responses, early decision excluded from retained tail, one agent run/settled and no retry/auto-compaction events. Automatic-mechanism disable setup missed; recorder incorrectly waited for `event` rather than `type` and timed out despite completed raw stream. Classify **partial protocol compliance, observed native behavioral pass**. Filler's inert-data wording weakens independence of non-goal check. Artifacts `/tmp/pi-compact-smoke-retry.2tUGVV/`; attempt1 remains blocked/unverified. No more requests.
- Final prior-pass check `29f219ae-d35a-4644-b909-5b6d7946e159` **exit0** at `36ae91f6`, 2,618 tests/types/lint; log `/tmp/pi-harness-autonomous-final-check.log`. Final dashboard addition independently passes52 unit tests, app/shared presentation types, changed-file Biome and2 mobile/desktop browser cases. Full aggregate was before this addition; do not relabel it as a post-addition full run. No live deployment authorized.
- Child integration 45 tests/types/Biome/isolated package build pass. Parent scoped integration + package/tool/worktree consumer suites **102 tests pass**; log `/tmp/pi-harness-batch-d-tests.log` (background `a6b85f7b-e70b-4ac1-a751-b1b66096a904` completed exit0).
- Parent package/extension types and changed-file Biome/whitespace pass. Sequencer assertion checks real fixture path (`3ead57a8`). Package runtime build validated only in isolated workspace; parent dist/live services are not upgraded.
- Historical batch A: `baseline-contract-tests@3` left a reviewed patch but hit carried-scratch integration guards. Initial overlap refusal and absent net-neutral path commit failure preserved checkout; no partial merge landed.
- Recovery complete: owned roadmap committed `a8c82859`; `baseline-tests-clean@1` reproduced exact reviewed patch from a clean base (inputs only, no inherited history), then `delegate_changes` squash landed `a1898260` with only 2 test files. No manual merge/rebase or integrator code changes.
- Final aggregate background `522db068-fbf5-4440-ab77-176e8c72a4ce` **completed exit 0**; log `/tmp/pi-harness-batch-a-final-check.log`. No active background dependencies.
- Reviewed final test patch: same-context wake dedupe, retention across requests, no redispatch/extra durable wake-state append; required migration indexes/data/FKs preserved and intentionally removed writer index explicit.
- Async setup blocker resolved: child inherits `PI_DELEGATE_CHILD=1`; normal `scripts/clean-npm-env.mjs` strips it. Named async test passes using cleaned launcher; migration/repository 57 and wake 6 pass.
- Premature aggregate `5407c382-f6c5-4faa-8820-9454d9e4348a` ran old tests before successful integration and is not final validation. Use the final aggregate handle above.
- Parent independent post-integration async + wake suites: **36 tests pass**. Changed-file Biome and diff whitespace pass. No production behavior changed.
- Do not read auth/credential files or raw user sessions; do not deploy or restart services. Routine evidence-backed local improvements are authorized within the agreed roadmap. Preserve APIs/defaults/order/persisted contracts; do not invent migrations, new restrictions or broader product features.
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
| 0. Baseline and boundaries | Complete for this pass | Measured baseline + ownership map; not an exhaustive line-by-line audit |
| 1. Agent-facing harness | Reviewed; native compaction observed | Prompt/tool exposure retained, docs corrected; C native behavioral pass with setup caveats, full runtime parity untested |
| 2. Execution/orchestration | Reviewed; D/E/deletion complete | Worktree/task seams improved; background/remote/shared runtime bounded review, no broader refactor justified |
| 3. Tools/integrations | Reviewed; no changes justified | Web/image/usage/validation/codemode: named owners, 60 focused tests pass |
| 4. Shared contracts/backend | Representative boundaries reviewed | Canonical parsers/models/coverage facades coherent; no justified new cuts or alias removal |
| 5. Presentation | Representative boundaries/config reviewed; explicit feedback UI added | Existing Markdown renderer reused for feedback inspector; TUI wrappers/shim contracts/theme/keybindings/prompt defaults preserved |
| 6. Development/operations | Reviewed; launcher fix complete | Scoped cleaned test args fixed; hooks/guards/deployment/metrics reviewed, no extra changes justified |

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

### Task/todo read-only audit (`481726e4`)

- Child `node scripts/clean-npm-env.mjs bun x vitest run extensions/tasks`: **35 tests pass** across 4 files. No code changes, whole-repo checks or model evaluations.
- Parent verifies state/field normalization, graph validation ownership, current result schemas/tests, immutable context/elision/reset semantics and command registrations.
- No verified task-state defect or justified structural refactor found. Small local tool-response duplication and documentation drift are actionable; no measured performance claims.

### Autonomous follow-up changes (`c7067a17`, `d12271e8`, `36ae91f6`)

- E: task tool result/error/details assembly centralized in existing helper; stats derived once, explicit registrations/metadata preserved. 35 tasks tests + extension types + changed-code Biome pass.
- Runtime: removed unused `PendingProcessAccounting.hasPending()`; parent verified no callers, supported count-based API unchanged. Child's 4 focused shared tests + types/Biome pass.
- Operations: original nested shell ignored forwarded scoped test paths/options (new regression failed: only `run` reached Vitest). Simplified root `test` script to guard Node then run cleaned Vitest directly; regression and real `PI_DELEGATE_CHILD=1 bun run test -- scripts/clean-npm-env.test.mjs extensions/tasks --reporter=dot` pass (37 tests/5 files). Workflow/AGENTS guidance now uses this supported launcher.
- Final `PATH="$PATH:/usr/sbin:/sbin" bun run check` exits **0** at `36ae91f6`: all guards/types/lint pass, **2,618 tests pass** (1,267 extension/script + 1,351 workspace). Six pre-existing lint and Node localstorage warnings remain non-fatal. No production deployment/restarts/parent dist upgrade.

### Explicit feedback-inspector addition (`2c8d5884`, `ab62da99`)

- User requested actual feedback text when inspecting a feedback action. Existing action projection now retains a string `message`; existing sanitized Markdown renders it under “Feedback message” only for the feedback action, without preview truncation. Action/target, result and raw details stay available; absent/non-string messages and other actions produce no block. Existing object-argument contract unchanged.
- Reviewed/squash-merged 4-file delegate delta (`2c8d5884`); parent completed synthetic empty API fixtures (`ab62da99`), no production endpoint/server changes.
- Post-merge parent: `bun run test -- apps/dashboard-web/src/entities/transcript/inspector.test.tsx packages/activity-model/src` **52 pass**; app + changed presentation-package types and four-file Biome pass.
- Parent final browser: mobile+desktop **2 pass**, isolated state/socket, unused43324/43325 and synthetic API responses; log `/tmp/pi-feedback-inspector-parent-e2e-verified.log`. No proxy errors in final run. Covers real transcript tool call → expanded activity → inspector → Markdown paragraph/list/code/result.
- No production `dist` rebuild, live entrypoint/health probe, service restart or deployment. Shared-package changes require the documented full dashboard deployment path if later authorized; source/test completion is not activation.

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

### F2 — Successful compaction behavior (native smoke recorded)

- `docs/harness-behavior-evaluation.md` case 3 specifies decision/non-goal retention, but previous comparison records `Nothing to compact (session too small)` and marks compaction blocked/not exercised.
- Proposed batch: make a disposable fixture reliably reach compaction; require actual successful compaction and subsequent constraint retention before changing policy. No auth-file access, real-session ingestion, or broad prompt rewrite. Model runs require normal harness-managed credentials and explicit evaluation scope/cost. **Recorded under explicit bounded scope; observed native behavioral pass with protocol/setup caveats**, not full default-harness parity. See C and `docs/harness-behavior-evaluation.md`.

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

### F5 — Small task tool response duplication + stale interface docs (verified)

- `extensions/tasks/tool.ts:67–71` derives stats for structured content; each handler (`:141–157`, `:179–195`, `:216–232`) repeats error handling/result assembly and derives identical stats again for details.
- Minimal simplification: let the existing `executeTodo` return the complete common tool result, using one stats derivation. Keep all three schema-typed registrations explicit; no generic registration factory, new file or framework. This is maintainability cleanup, not a measured speed claim.
- `docs/todo-context.md` still describes old `list`/batch steps/generated IDs, a `/todo` overlay, and `/tostats`. Current `commands.ts` registers only `/todo` (widget update + notification/headless print) and `/todump`; schemas reject the old action selector. Text list is bounded, while structured content returns selected task records/stats.
- Core ownership already sound: store loads/persists state; mutation layer builds/validates atomic candidate graph; domain owns dependency predicates. Store→domain runtime edge's reverse import is type-only. Do not refactor away an apparent cycle or repeat historical audit finding.
- Preserve legacy todo/snapshot identifiers and persisted `State.version:1`/`nextId` contract; historical context/metrics have named consumers. No storage migration or new validation restrictions.

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

### C. Successful native compaction smoke — recorded with caveats

- Prepare a reproducible disposable fixture, pinned harness/config/model/thinking and bounded run budget. Keep case decision/non-goal in conversation rather than re-reading them from a progress file, otherwise the fixture would test a different mechanism.
- Require a successful compact response and correct continuation preserving both constraints; blocked/setup failure is not a pass. Record transcripts/results without credentials or production state.
- Do not change prompt/routing/compaction code until evidence warrants it. Single trials are smoke evidence, not general cost/quality claims. **Retry complete: partial protocol compliance, observed native behavioral pass.** Attempt1 remains blocked/unverified. Parent verified retry raw summary/continuation and settled event; automatic-mechanism disable was missed, recorder sidecar incorrectly timed out, filler has an inert-persistent-data caveat. No more model requests, prompt changes, broader benchmarks or provider/config repair.

### D. Commit the effective task delta during squash — complete

- Scope: portable integrator squash commit-path selection in `packages/worktree-manager/src/integrate.ts`, regression at its real-Git integration-test boundary (existing extension suite is acceptable). No wrapper/base migration, new API, broad cleanup or weakened dirty-overlap guard.
- Candidate remedy: derive staged changed paths after no-commit cherry-pick and restrict commit to the task-owned effective delta. Preserve normal tracked-file deletions. Handle an empty effective delta explicitly with a safe, clear no-op outcome rather than an accidental broad commit.
- Acceptance: carried-only deletion plus actual edit/addition squashes to one correct parent-authored commit; absent file is not introduced; tracked deletion still lands; add-then-delete/net-neutral task paths do not poison pathspecs; no effective delta creates no empty/spurious commit.
- Ownership/safety: dirty task-path overlap still refuses; unrelated staged/unstaged/untracked files and pre-existing stash stack are preserved; genuine conflicts/commit failures restore HEAD/index/worktree and operation state. Existing cumulative/patch-identity behavior remains unchanged.
- Validation: reproduce regression before fix; focused real-Git integration suites, package + extension typechecks as needed, changed-file Biome, exact commit/diff assertions and rollback checks. No production deployment or full harness rewrite.
- Approval/result: **approved; integrated `0018adcf` + test correction `3ead57a8`; kept**. 102 scoped tests/types/Biome pass; isolated package build passes. No runtime API/state model or wrapper/base changes. Live activation/deployment remains unperformed.

### E. Simplify task tool result assembly and align docs — complete

- Scope: `extensions/tasks/tool.ts`, a few semantic assertions in existing `tasks.test.ts`, `docs/todo-context.md`. Use existing helper to assemble output/error/details once and reuse stats; registrations and metadata stay explicit.
- Acceptance: all three tool output schemas, IDs/order/task selection, bounded text, error behavior and detail stats remain equivalent; dependency/status/atomicity/persistence/UI/context semantics unchanged. Existing 35 tasks tests plus a small equality assertion for structured/detail stats are sufficient; avoid a new scenario matrix.
- Documentation: remove non-existent commands/old batch/generated-ID claims; describe current bounded text and structured records plus actual commands. Do not remove legacy runtime compatibility to match docs.
- Validation: focused task tests, extension typecheck and changed-code Biome/diff check; manual docs/schema/command match. No broader refactor, extra safety policy, benchmark claim, dashboard deployment or full check required.
- Result: **complete `c7067a17`; kept**. Existing helper assembles one result/stat projection; explicit registrations and all behavior retained. 35 focused tests/types/Biome pass; net code deletion.

## Deliberately unchanged

- Canonical system-prompt owner, composition order, intentional rejection of direct prompt inputs and documented hook precedence.
- Optional hybrid codemode with native `models.*` disabled; child tool allowlists and explicit skills.
- No broad delegate decomposition, protocol/storage migration, dynamic plugin/state framework, feedback triage or performance claims.
- Six existing lint warnings are recorded but not used to widen the first batch.
- Bounded runtime, tools, shared/backend and presentation/config passes completed. No broader structural change justified; preserve named consumers and exact SDK shim-removal gates.

## Completion and deferred work

Prior incremental improvement pass is complete in source with full validation and recorded compaction caveats. Explicit addition integrated as `2c8d5884`: actual `delegate_jobs` feedback `message` shown as labeled Markdown in the existing inspector, no preview truncation, other action/missing/invalid-message behavior preserved. `dashboard-feedback-message@2` reviewed and squash-merged (4 files); semantic unit + mobile/desktop browser tests added. Parent post-merge 52 tests/apps + presentation-package types/Biome pass. Parent fixture cleanup `ab62da99` uses existing empty history/settings/thread response shapes. Final isolated parent recheck passes2 mobile/desktop cases without API proxy errors on unused43324/43325; log `/tmp/pi-feedback-inspector-parent-e2e-verified.log`. Initial successful runs' non-fatal unmocked queries led only to test fixture cleanup, not backend changes. No production activation. Source, scoped checks and isolated browser coverage are **complete**. No live build/deployment/restart authorized. No further refactors proposed without evidence; this incremental pass is closed. Deferred: live activation, full-default-runtime compaction parity/automatic-threshold evaluation, and broader measured performance/cost comparisons. Historical single-trial results do not establish overall optimization.

Historical integration friction (carried scratch overlap, then absent-path `commit --only`) aborted safely and led to tracked roadmap/clean-base child recovery and verified batch D fix. Version roadmap before writable child launches. Use `bun run test -- <path>` for the cleaned scoped launcher. Preserve unrelated checkout work; no feedback-ticket triage, product/storage migration, broad prompt rewrite, deployment or service restart.
