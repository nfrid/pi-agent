# HFM-20260730: Measure read-only review lifecycle outcomes

- **Status:** evaluation-pending
- **Approval:** approved 2026-07-30
- **Created:** 2026-07-30
- **Source reports:** [HF-20260729: Review snapshot evaluation counts are not measurable](../inbox/20260729T141707Z-review-evaluation-counts-not-measurable.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

The privacy-safe session metrics report aggregate delegate calls, continuations, and worktree returns, but cannot distinguish the lifecycle outcomes required by current ticket evaluation windows: successful clean read-only snapshot retirement, same-snapshot continuation, WIP versus HEAD refresh outcomes, or dependency projection for carried WIP packages. Maintainers must reconstruct those counts manually, which risks undercounting, double-counting, and unsupported evaluation decisions.

## Baseline

In one observed evaluation session, 2 clean read-only runs, 1 same-snapshot continuation, 1 failed WIP refresh, and 1 WIP-package dependency projection had to be recorded manually because `npm run session:metrics` exposed only aggregate delegate and worktree counts.

The current schema-v5 summary in `scripts/session-metrics/index.mjs` counts delegate calls, generic continuations, outcomes, background delivery, and whether a result returned a worktree. It deduplicates execution facts by stable run ID, but it does not classify read-only snapshot lifecycle semantics. The delegate tool already records the omitted/WIP/HEAD refresh selector, and final worktree state identifies successful unchanged read-only snapshots. Dependency links are created and retained in internal worktree records, but the returned privacy-safe worktree summary does not expose their count or snapshot base.

No existing ticket covers metrics observability. The snapshot-retirement and WIP-dependency tickets define the evaluation samples that this proposal would make measurable; this ticket does not alter those lifecycle behaviors.

## Hypothesis

If session metrics classify existing delegate calls and results by stable tool-call/run identity, and worktree results expose only the minimum enum and integer metadata needed for dependency projection, then maintainers can measure the pending lifecycle evaluation windows directly without retaining paths, task text, prompts, or transcripts.

## Guardrails

- New worktree-summary fields and aggregate metrics may contain only enums, booleans, and counts; they must not add repository paths, task text, prompts, transcript content, carried filenames, dependency names, or handoff bodies. Existing operational worktree handoffs may retain the paths they already require, but metrics must not copy them.
- Count each execution once even when the same completion is delivered automatically and by inspection.
- Correlate calls and results by tool-call ID and stable run ID; do not rely on positional pairing.
- Preserve zero-compatible parsing for sessions created before the new fields exist.
- A clean retirement excludes writable, changed, failed, aborted, timed-out, lifecycle-error, and diagnostically retained worktrees.
- Omitted refresh means same-snapshot continuation; WIP and HEAD refreshes remain separate categories.
- Rejected or failed refresh attempts must not count as successful refresh samples.
- Do not add a new event stream, transcript store, path hashing, or general analytics framework.

## Options considered

1. **Continue manual ticket observations:** No code change, but leaves evaluation thresholds error-prone and non-reproducible.
2. **Derive all distinctions from current session output:** Preserves current schemas, but dependency projection is not represented and generic continuation/worktree indicators cannot reliably classify outcomes.
3. **Add bounded lifecycle counters plus minimal result metadata:** Makes the required evaluation samples reproducible while retaining current privacy boundaries and stable-ID deduplication.
4. **Store detailed lifecycle events or transcripts:** Easier to query later, but unnecessarily broad and conflicts with the privacy-safe aggregate design.

## Recommendation

Implement option 3. Extend the worktree result summary only with the snapshot base and numeric carried-file, dependency-projection-candidate, and dependency-link counts needed for classification. Extend `session:metrics` to correlate delegate calls and final results and emit aggregate counters for:

- successful clean read-only snapshot retirements;
- successful same-snapshot continuations;
- WIP and HEAD refresh attempts, successes, and failures; and
- total WIP package-review attempts, with mutually exclusive subcounts for successful nonzero dependency projections, zero-link projections, and projection failures; the total must equal the three subcounts.

Retain the existing stable-run deduplication rules and schema-version the summary change.

## Scope

- **In:** Minimal privacy-safe worktree summary fields; call/result correlation; aggregate lifecycle counters; legacy-session behavior; focused metrics and delegate lifecycle tests; documentation of the new summary fields.
- **Out:** Changing delegate lifecycle behavior; automatic ticket edits; storing paths or task content; general telemetry; external analytics; retroactively inferring details absent from legacy sessions.

## Acceptance criteria

- [x] Metrics count each successful unchanged read-only snapshot retirement exactly once and exclude writable, changed, failed, aborted, timed-out, and lifecycle-error runs.
- [x] Metrics distinguish successful same-snapshot continuations from fresh delegate runs.
- [x] Metrics report WIP and HEAD refresh attempts, successes, and failures separately, including preflight failures that have a correlated tool result.
- [x] Duplicate automatic and inspected handoffs do not double-count one lifecycle execution.
- [x] Metrics report a total WIP package-review-attempt denominator plus mutually exclusive successful-nonzero, zero-link, and failed-projection subcounts; the total equals the sum of those subcounts without exposing package names or paths.
- [x] Sessions without the new metadata remain parseable and report zero or unavailable lifecycle counts rather than fabricated samples.
- [x] Aggregate metrics contain no task text, prompts, paths, filenames, dependency names, or transcript bodies, and the new worktree-summary fields add only bounded enums and numeric counts.
- [x] Existing session-metrics and delegate behavior tests remain unchanged in meaning and pass.

## Validation

- Add parser fixtures for fresh read-only runs, same-snapshot continuations, successful and failed WIP/HEAD refreshes, duplicate completion delivery, legacy results, and changed/error/writable exclusions.
- Add worktree summary tests proving the new fields expose only snapshot-base enums and numeric candidate/link counts; assert they add no paths or names while preserving existing operational handoff fields.
- Correlate parallel and background fixtures by tool-call/run IDs and assert positional ordering cannot change counts.
- Run focused session-metrics, delegate lifecycle, worktree, and orchestration tests, then `npm run check`.
- Compare metrics output with manually verified observations for at least 10 real read-only review runs, including at least 2 same-snapshot continuations, 2 refresh attempts, and 2 WIP package-review attempts, with any zero-link projection visible rather than silently omitted.
- **Implementation validation (2026-07-30):** `npm run check` passed TypeScript, Biome checks, Pi SDK alignment, and 62 Vitest files / 571 tests.

## Evaluation

- **Window:** In progress; 10 real read-only review runs including at least 2 same-snapshot continuations, 2 refresh attempts, and 2 WIP package-review attempts, evaluated no earlier than 2026-08-20
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare automatically reported lifecycle counts with manual ground truth for the bounded window. Keep only if counts match, no duplicate delivery inflates samples, and no sensitive fields appear in output.

## Implementation and resolution

- **Approved implementation:** Option 3 approved by the user on 2026-07-30
- **Merged change:** `a4b0962 feat(metrics): measure read-only review lifecycle`
- **Resolution:** pending evaluation
