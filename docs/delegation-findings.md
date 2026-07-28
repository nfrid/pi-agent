# Delegation findings

Reviewed candidates from the Phase 1–3 measurement work, in the format `proposal.md` sets out. A candidate is recorded only where a pattern recurs across sessions or a single failure is severe.

**Creating a candidate is not approving it.** Nothing here has been promoted into a route description, a system guideline, a tool, or a skill. Each names the smallest useful intervention and how a later cohort would show whether it worked.

Sources: `docs/delegation-baseline.md` (what handoffs cost the parent), `docs/delegation-routing.md` (where work is routed and what it costs to run), and the Phase 3 A/B recorded in `plan.md`.

## 1. A broad audit spends its whole budget and returns nothing to decide with

**Observation.** A repo-wide `terra-max` audit hit the 600 s delegate timeout on both arms of the Phase 3 A/B, from the same prompt. The parent received a status line, a continuation token, and one sentence — `Delegated task timed out after 600 seconds.` — and no findings.

**Evidence.** Phase 3 round 1, `a1-audit`, arms A and B. `terra-max` averages 17.4 turns per task against a cohort mean of 4.1 (`docs/delegation-routing.md`), so it is the route most likely to run long. The mechanism to surface partial work already exists: `runBody` in `extensions/delegate/output.ts:214` prefers the child's final assistant text over the error. It returned nothing here because the child spent all 600 s in tool calls without ever emitting text.

**Impact.** Ten minutes of the most expensive route, at roughly $1.33 a task, for zero decision-relevant output. The work is recoverable — the continuation token is issued for timed-out runs too, and the child's session is intact — but the parent cannot tell whether to resume, split the task, or re-route, because it has nothing to judge.

**Proposed destination.** The delegate prompt, in `extensions/delegate/prompt.ts`.

**Proposed change.** Ask a child to emit an interim summary before it is deep into a broad sweep — one short report of what it has established so far — so a run that is killed still hands back something. Do not raise `timeoutMs`; that spends more on the same failure. Splitting broad audits is a parent-side habit and belongs in guidance, not in the extension.

**Validation.** Timed-out runs in a later cohort carry a non-empty body. Watch `delegateHandoffBytes` for timed-out tasks specifically — currently effectively zero.

## 2. `terra-max` is 11% of the tasks and 44% of the spend

**Observation.** Child spend is concentrated in one route far more sharply than task count is.

**Evidence.** `docs/delegation-routing.md`: 25 tasks of 224 on `terra-max`, $33.12 of $76.08 total, 17.4 turns per task — more than twice the per-task cost of any other route and four and a half times `terra-high`, which itself carries 41% of tasks.

**Impact.** If routing has an economy lever, this is it. The distribution is barbelled — cheap triage at one end, `terra-high`/`terra-max` at the other, with `luna-medium` and `luna-high` together taking 15% — which is the shape produced by picking a safe default rather than fitting the route to the task.

**Proposed destination.** Route descriptions in `settings.json`, or parent guidance. Possibly no change.

**Proposed change.** None yet. Turn count is the signal worth watching first: a route running consistently long is either under-powered or being handed tasks that should have been split, and those two want opposite interventions. Deciding between them from 25 tasks would be guessing.

**Validation.** `routes['terra-max'].turns / tasks` against `tasks` share in a later cohort. Falling turns with a steady share means decomposition improved; a falling share alone only means the route is being avoided.

## 3. The escalation path has never been taken

**Observation.** `Exceeded:` exists so a child can report that a task outran its route without naming a rung it cannot see, and the parent can resume that same child on a stronger route with its session intact. No continuation in the corpus has ever changed route.

**Evidence.** 65 continuations whose original route could be identified, zero route changes (`docs/delegation-routing.md`). One genuine `Exceeded:` line in the corpus, not escalated.

**Impact.** Unknown, and that is the point. Either the parent is absorbing shortfalls by re-running work itself — which pays for the same exploration twice — or tasks are routed well enough that escalation is genuinely rare.

**Proposed destination.** No change.

**Proposed change.** None. Most of the corpus predates the Phase 2a contract (`8e74efa`), so children had no `Exceeded:` field to report a shortfall with and the parent had little to act on. The honest reading is that the path is unexercised, not broken.

**Validation.** `delegateEscalationRate` was added for exactly this (`909fb3b`). Read it on a post-`8e74efa` cohort. A rate still at zero once children can report shortfalls is a real finding; today's zero is not.

## 4. Read-only children fill `Validation` and `Evidence` with narration

**Observation.** Children with no write access pad `Validation` with narrated tool calls — "Read all six requested files: succeeded" — and fill `Evidence` with descriptions of process rather than citations. The contract asks for neither.

**Evidence.** Phase 3 arm B, observed across its delegate calls.

**Impact.** Two of the envelope's most expensive fields spent on text that carries no decision. Because the envelope is allocated before bodies and survives truncation, padding here is the costliest possible place for it — it displaces report body under the caps tightened in `72b9dfc`.

**Proposed destination.** `extensions/delegate/prompt.ts`.

**Proposed change.** Say what `Validation` means when nothing was run: a read-only task that executed no checks should leave it empty rather than describe its own reading. `Evidence` already asks for citations; the failure is that a child with nothing to cite writes prose instead of omitting the field.

**Validation.** Weak evidence — a handful of calls in one arm, not a measured rate. Before acting, count how often `Validation` on a read-only task contains no command. If that is rare, this is one model's habit and not a contract problem.

## Why these are not in `~/job/.agents/feedback/inbox/`

`proposal.md` Phase 4 routes recurring findings into the reviewed feedback process in `~/job`. That destination is wrong for these particular findings, and deliberately so.

`~/job/AGENTS.md` scopes the inbox to "concrete, reusable **workspace-workflow** friction observed during a task", and its README adds that agents "must not hunt for feedback or record low-signal friction". Every finding above is a defect in the delegate extension in this repository, found while working in this repository — not friction in the MyGig workspace, and not observed during a `~/job` task. Filing them there would misfile them and would burn the first entries in an empty inbox on work that repository does not own.

The pipeline Phase 4 actually asks for — measured evidence becomes a reviewed candidate, and promotion stays an explicit human action — is what this document is. When delegation findings do surface during `~/job` work, that inbox is the right destination and the `workflow-feedback` skill is the right procedure.
