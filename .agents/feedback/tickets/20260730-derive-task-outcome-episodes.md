# HFM-20260730: Derive task outcome episodes automatically

- **Status:** evaluation-pending
- **Approval:** approved 2026-07-30
- **Created:** 2026-07-30
- **Source reports:** [HF-20260730: Measure end-to-end task outcomes, not only harness events](../inbox/20260730T095735Z-task-outcome-benchmark.md); [HF-20260802: Activity grouping and outcome metrics disagree on validation commands](../inbox/20260802T133848Z-activity-group-validation-policy-diverges.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

The privacy-safe session metrics describe harness activity and cost, but not whether a user's task reached a validated result, was accepted or advanced by the user, or was reopened for correction. The original docs-first pilot proposed manually filing outcome records after each task. The user rejected that approach on 2026-07-30 because ongoing recording and filing would itself create unacceptable harness friction.

The session already contains structured todo transitions, timestamps, tool calls and results, provider and delegate outcomes, commits, validations, and subsequent user reactions in both English and Russian. These signals are not correlated into task-level episodes, so prompt, routing, and workflow changes can improve local event counters while their effect on end-to-end work remains unknown.

## Baseline

`docs/session-metrics.md` says that the current `session:metrics` summary measures observed cost and reporting, not correctness. It follows active ancestry and reports session elapsed time, turns, delegation outcomes, handoff volume, provider/process failures, tool-argument blocks, and read-only review lifecycle counters. It has no task-episode boundary, plan outcome, validation outcome, commit outcome, user disposition, correction/reopen, or recovery-effort metric.

The source observation had two `sol-medium` delegate attempts end in provider-overload errors before the parent completed the review directly. Existing metrics can count the process errors and session span but cannot connect them to the completed parent task or its subsequent user acceptance.

A bounded inspection on 2026-07-30 found:

- among 18 recent active session branches, 51 substantive user messages, 10 sessions with persisted todo state, and 18 transitions from active todos to an all-`done` plan;
- among 30 recent sessions in a separate todo-focused audit, 20 used todos, 19 ended with `active=0` and `blocked=0`, one ended with 3 active and 1 blocked task, and 10 had no todo plan;
- the 19 terminal plans each retained 2–6 tasks, but 9 later received another user turn and 13 had earlier tool failures, demonstrating that plan closure alone is not external correctness;
- among the latest 80 `~/job` session files, active-branch inspection found 51 Russian user messages. Recurring Russian cues included explicit approval or acceptance (`одобряю`, `годится`, `отлично`), advancement (`приступай`, `продолжай`, `коммить и пушь`), and reopening (`всё ещё`, `ошибка`, `исправь`). Mixed-language cues such as `lgtm, коммит и пуш` also occur.

Naive keyword matching is not reliable. English questions such as “what must I approve before we proceed?” contain approval and advancement words without granting approval. Russian phrases such as `по-хорошему` contain `хорошо` without expressing acceptance, while a conditional statement that something “would be an error” is not necessarily a confirmed regression.

The existing read-only lifecycle metrics ticket is not a duplicate: it measures specific delegate/worktree mechanics needed by other evaluation windows, whereas this proposal derives whole-task and phase outcomes.

## Hypothesis

If `session:metrics` derives task episodes from active-ancestry structure, todo epochs, tool results, and high-precision English and Russian user-disposition rules, then it can report operational completion, observed verification, phase advancement, correction, and recovery effort without user recording or new runtime telemetry. This should work because structured evidence establishes what happened operationally, while the next user reaction can retrospectively qualify—but not overwrite—the agent's self-reported plan completion.

The hypothesis is falsified if episode boundaries or strong disposition labels fail to reach 90% precision on a stratified historical holdout, privacy-safe output requires retaining task content, or fewer than 30% of eligible follow-up reactions can be classified without lowering that precision.

## Guardrails

- No forms, prompts, manual per-task records, benchmark ledger, or user filing workflow.
- Preserve the current output privacy boundary: emit no prompts, user text, task text, repository paths, filenames, tool arguments/results, command text, transcript bodies, secrets, ticket identifiers, or global user/repository identifiers.
- Local parsing may inspect existing session content and arguments, as current metrics already does, but new episode fields may emit only bounded enums, counts, durations, booleans, language buckets, and non-linkable per-export ordinals. Retain the existing documented top-level local `sessionId` unchanged; it is not an episode identifier or an anonymity guarantee.
- Do not send session content to a model or external classifier. English, Russian, and mixed-language disposition classification must run locally and deterministically.
- Keep structured facts, inferred dispositions, and retrospective proxies separate. Never present `inferred-settled`, `all todos done`, or `validation passed` as semantic correctness.
- Prefer `unknown` over a low-confidence language classification. Report unknown and missing-value denominators.
- Distinguish `done`, `dropped`, `blocked`, empty, and absent todo plans. Dropped work is not completion; blocked work is unfinished; no todo is not failure.
- Count retries and executions by stable tool/run identity and active ancestry, preserving existing duplicate-delivery handling and legacy-session compatibility.
- Do not add a session event stream, runtime extension, replay system, automatic route change, dashboard, transcript store, or external telemetry.

## Options considered

1. **Continue with session-level event metrics:** No implementation cost, but cannot correlate harness mechanics with task outcomes.
2. **Maintain a manual outcome ledger:** Can capture subjective correctness, but the user rejected its recurring recording and filing burden.
3. **Derive episodes offline from existing session JSONL:** Adds bounded parser and classification logic, requires no runtime interaction, works retroactively, and can preserve privacy by emitting only aggregate facets.
4. **Add a runtime outcome extension or required final tool call:** Produces cleaner boundaries but changes agent behavior, remains self-reported, creates new session state, and misses historical sessions.
5. **Use an LLM judge or build a replay corpus now:** Could assess semantics more deeply, but adds cost, content disclosure, nondeterminism, and infrastructure before the value of automatic episode metrics is established.

## Recommendation

Implement option 3 in `scripts/session-metrics` and reuse or extract the retry-aware tool classification already implemented by `extensions/activity-groups/outcome.ts` rather than maintaining divergent validation semantics.

### Episode boundaries

Derive boundaries in descending confidence:

1. **Todo epoch:** Begin when persisted todo state moves from no unfinished work to one or more `todo`, `doing`, or `blocked` tasks. Keep the epoch open while any task is unfinished. It ends normally only when no unfinished tasks remain, classified as `all-done`, `dropped-only`, or `mixed-terminal`; only `all-done` is plan completion. A `replace` that removes or rewrites unfinished work closes the prior epoch as `superseded` and starts another if the replacement has unfinished work. Removing the final unfinished task closes it as `removed`, not completed. `clear_done` is housekeeping and neither starts nor ends an epoch. An active or blocked plan at the selected branch leaf is observation-censored, not a completed episode.
2. **Agent-run fallback:** For work without todos, begin at an independent user message and continue through tool calls, retries, steering, queued follow-ups, and automatic completions. Because `agent_settled` is not persisted in session JSONL, infer a settled end only from a terminal assistant response with no pending tool-use/result chain represented before the next user turn; classify incomplete session tails as censored rather than settled.
3. **Linked phase transition:** Inspect exactly the immediate next active-ancestry user turn—never skip inquiry or ambiguous turns—and classify its disposition before linking. A high-confidence `advance` imperative such as implement, test, commit, merge, proceed, `приступай`, `продолжай`, or `коммить` opens a linked phase; a high-confidence `revise` opens a linked correction phase. `accepted` closes attribution. `inquiry`, `new-task`, or `unknown` ends attribution and the turn begins a fallback episode if it initiates agent work.

### Evidence facets

Emit independent fields rather than one correctness score:

- **Operational:** inferred-settled, failed, aborted, timed out, censored, or unresolved-tool-failure.
- **Plan:** absent, active-censored, blocked-censored, all-done, dropped-only, mixed-terminal, superseded, or removed.
- **Mutation:** time to first successful explicit mutation and whether later mutations followed validation.
- **Validation:** not observed, passed, failed, or stale-after-later-mutation; attempts and retries by lint, test, typecheck, format, and aggregate check.
- **Delivery:** commit/merge/amend attempt and result, detected from local command/result correlation without emitting command text.
- **Delegation recovery:** route/provider failures, parent turns and tool calls after failure, and whether the parent later reached an inferred-settled episode or `observedVerification`. Call this recovery effort, not subjective rework.
- **Structural shape:** classify only from observable tool patterns as `analysis-only`, `mutation-unvalidated`, `mutation-validated`, `operations`, or `other`; do not infer semantic task topics from text or paths.
- **User interaction:** mid-run user steering/follow-up count and the next reaction's disposition.

### English and Russian disposition

Classify only the immediate next active-ancestry user reaction, with precedence:

1. `revise` — confirmed failure, correction, fix, amend, revert, or still-broken instruction;
2. `accepted` — explicit first-person approval or unqualified positive acceptance;
3. `advance` — unambiguous imperative to implement, test, commit, merge, push, or move to the next phase;
4. `inquiry` — question or discussion that neither accepts nor rejects the result;
5. `new-task` — structurally independent work;
6. `unknown` — insufficient or conflicting evidence.

Support English and Russian inflections plus mixed-language messages. Normalize Unicode and case, but use phrase shape, imperative/first-person structure, punctuation, negation, interrogatives, and cue position rather than bare substring matching. Revision overrides praise in constructions equivalent to “good, but it still fails.” Questions suppress approval/advance unless they also contain a separate unambiguous imperative. Language-neutral structured signals remain primary.

### Derived cohort measures

Report by structural shape and language bucket (`english`, `russian`, `mixed`, or `unknown`) without emitting text:

- operational and all-plan-done rates;
- observed-verification rate, defined as an inferred-settled episode with a recognized successful validation after its final successful mutation;
- explicit acceptance and advancement rates;
- revision/reopen rate;
- all-done-followed-by-revision (`falseDoneProxy`) rate;
- validation retry and stale-validation rates;
- elapsed time to first mutation, plan closure, successful validation, and user acceptance/advancement;
- recovery turns/tool calls after delegate or provider failure;
- blocked, dropped, no-todo, and unknown-disposition denominators; and
- approval → implementation → validation → commit phase duration where all boundaries are observed.

Expose per-episode privacy-safe records only behind an explicit JSON option; default summaries should remain aggregate. Identify episodes only by a per-export ordinal that cannot be joined across exports. Do not emit deterministic or content-derived episode hashes, and do not modify the session JSONL schema.

## Scope

- **In:** Active-ancestry episode extraction; todo epoch semantics; no-todo fallback; retry-aware mutation and validation classification; commit/merge result classification; delegation recovery effort; deterministic English/Russian/mixed user disposition; privacy-safe episode and cohort output; legacy fixtures; documentation.
- **Out:** Semantic correctness grading; user forms or annotations; runtime state or prompts; model judges; content retention; replay execution; dashboards; external telemetry; automatic route/prompt changes; product-project metrics.

## Acceptance criteria

- [ ] Active-ancestry parsing produces deterministic episode boundaries without counting abandoned branches or duplicate completion deliveries.
- [ ] Todo epochs remain open while any task is unfinished; terminal classifications distinguish all-`done`, dropped-only, mixed-terminal, superseded, removed, active-censored, blocked-censored, empty, and absent plans, and only all-`done` contributes to plan-completion rate.
- [ ] `replace`, `remove`, and `clear_done` follow the explicit epoch semantics above and cannot turn discarded work into completion.
- [ ] Tasks without todos receive an agent-run episode without fabricating a plan outcome; terminal assistant evidence and censored tails are distinguished without claiming that offline JSONL contains `agent_settled` events.
- [ ] The immediate next user turn is classified once before linkage; only high-confidence `advance` or `revise` opens a linked phase, and inquiry or ambiguous turns are never skipped.
- [ ] Validation attempts and retries distinguish lint, test, typecheck, format, and aggregate checks; a later mutation makes an earlier passing validation stale.
- [ ] Failed tool calls resolved by a correlated later success do not remain unresolved, while unrelated successes do not erase failures.
- [ ] Commit, amend, merge, and push attempts are correlated with their results without exposing commands, branches, remotes, paths, or commit messages.
- [ ] Parent activity after delegate/provider failure is reported as recovery turns/tool calls and can be connected to a later inferred-settled episode or `observedVerification`; the latter requires successful recognized validation after the final successful mutation.
- [ ] English fixtures classify explicit approval, imperative advancement, correction, and inquiry while rejecting keyword traps such as “what must I approve before we proceed?”
- [ ] Russian fixtures cover approval (`одобряю`, `годится`), advancement (`приступай`, `продолжай`, `коммить и пушь`), revision (`всё ещё не работает`, `ошибка`, `исправь`), questions, negation, inflection, and mixed-language cues; `по-хорошему` is not classified as acceptance.
- [ ] Conflicting praise-plus-correction is `revise`; interrogative or conditional cue usage is not promoted to acceptance or advancement; uncertain cases are `unknown`.
- [ ] New episode output contains only bounded enums, counts, durations, booleans, language buckets, and per-export ordinals—never new stable/content-derived hashes, task/user text, paths, filenames, tool arguments/results, command text, ticket IDs, or transcript bodies. The existing documented top-level local `sessionId` remains unchanged and is not used as an episode identifier.
- [ ] Structural shape is derived only from tool patterns as `analysis-only`, `mutation-unvalidated`, `mutation-validated`, `operations`, or `other`; cohort output includes sample and missing/unknown denominators and never combines different shapes.
- [ ] Legacy sessions lacking todo snapshots or newer delegate metadata remain parseable and report absent/unavailable values rather than fabricated evidence.
- [ ] Existing session metrics, activity grouping, todo, and delegate lifecycle behavior remains unchanged in meaning and passes its tests.

## Validation

- Extract reusable retry/validation classification with focused parity tests proving activity-group rendering and session metrics classify the same corrected and unresolved calls.
- Add active-ancestry fixtures for all-done, blocked, dropped, mixed-terminal, repeated todo epochs, no-todo tasks, compaction, tree navigation, steering/follow-ups, duplicate delegate delivery, provider failure followed by parent recovery, and legacy sessions.
- Add validation fixtures for pass, fail, retry, aggregate-to-explicit correction, unrelated success, and mutation-after-validation.
- Add commit/merge fixtures for successful, failed, amended, and absent delivery without asserting or emitting sensitive arguments.
- Build a sanitized bilingual disposition fixture table from observed phrase shapes, including positive, negative, interrogative, conditional, negated, praise-plus-correction, phase-transition, and mixed-language cases.
- Before tuning disposition rules, freeze a deterministic stratified historical sampling frame and annotation guide. Keep development examples separate from a holdout of at least 60 episodes containing at least 20 English reactions, 20 Russian reactions, 10 ambiguous/question/negation cases, todo and no-todo tasks, and provider/delegate failures. Two reviewers independently label episode start/end entry indexes and dispositions, then adjudicate disagreements. This is one-time implementation validation, not an ongoing user recording workflow.
- Count a todo boundary match only when both start and end active-ancestry entry indexes match adjudicated labels exactly; for no-todo fallback allow the inferred end to differ by at most one terminal assistant entry. Require at least 90% episode-level boundary agreement.
- Require at least 10 holdout predictions for each of `accepted`, `advance`, and `revise`, and at least 90% precision for each label separately; otherwise record `insufficient evidence`. Report per-label recall and unknown rate rather than weakening rules to meet coverage.
- After adjudication, retain only aggregate confusion counts and strata; do not retain prompts, excerpts, source/content hashes, or a recoverable annotation-to-session mapping.
- Assert with a strict output allowlist that neither new per-episode nor cohort fields contain sensitive fields or stable identifiers; explicitly allow the unchanged documented top-level local `sessionId`.
- Run focused session-metrics, activity-group outcome, todo, and delegate tests, then `npm run check`.

## Evaluation

- **Window:** Started 2026-07-31; the first 50 automatically derived eligible episodes spanning English and Russian, evaluated no earlier than 2026-08-20; no user recording or filing required
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Keep only if parsing completes without privacy violations or manual repair, structural invariants hold, and at least 30% of eligible immediate follow-up reactions receive a non-`unknown` disposition while preserving every per-label historical precision threshold. The predeclared workflow comparison is failure-affected episodes versus no-failure episodes within the same structural-shape and language buckets: if the window contains at least 10 failure-affected and 20 matched no-failure episodes, report median time-to-observed-verification and revision-rate deltas. A median time increase of at least 25% or revision increase of at least 10 percentage points triggers a separate routing-reliability proposal; a smaller difference records no routing change. Revise language rules if Russian or mixed-language unknown/error rates materially exceed English after controlling for structural shape. Record `insufficient evidence` if the episode, label, language, or comparison cohort minimum is not reached. This ticket does not itself authorize route or prompt changes.

## Implementation and resolution

- **Approved implementation:** Option 3, automatic offline episode derivation with the boundaries, bilingual classifier, privacy constraints, validation thresholds, and evaluation window above; approved by the user on 2026-07-30
- **Merged change:** `76c6261` (implementation `e1acaf6 feat(session-metrics): derive task outcome episodes`); review fixes `204a258` (implementation `dac27cb fix(session-metrics): harden episode regressions`), `5413ef3` (implementation `70b5feb fix(episodes): tighten disposition and recovery inference`), `4a1f03d` (implementation `59ee236 fix(session-metrics): harden disposition phrase classification`), and `bdd9b68` (implementation `b975c98 fix(session-metrics): require separate imperative after inquiry`)
- **Resolution:** pending evaluation
