# Session metrics

`scripts/session-metrics` reads Pi session JSONL and emits privacy-safe aggregate measurements. It follows only the active ancestry, so abandoned branches do not inflate totals.

```bash
bun run session:metrics -- summarize ~/.pi/agent/sessions --min-delegate-calls 1
bun run session:metrics -- compare --baseline /path/to/baseline --comparison /path/to/comparison
```

JSON is written to stdout. `--limit` applies after filtering; `--min-todo-calls` and `--min-delegate-calls` can be combined.

## Delegation

The instrument reports delegate calls, continuations, accepted parallel calls, rejected calls, unique delegated and writable tasks, jobs/runs launched, report deliveries, handoff bytes, truncation, report outcomes, process errors/timeouts/aborts, and worktree indicators. It also retains compatibility counters for the superseded automatic-completion and terminal `delegate_jobs peek` paths, plus strict unknown-tool-argument blocks (`unknownToolArgumentBlocks`) from errored tool results. Normal asynchronous workflows use logical attempts, optional `delegate_gate` batching, and metadata-only `delegate_jobs`; workflow results otherwise arrive through eager delivery.

For historical sessions and internal compatibility calls, automatic deliveries use `details.jobs`, while legacy `delegate_jobs peek` uses `details.job`. A pushed report and a later peek each add their complete delivered text to `delegateHandoffBytes`; `delegateBackgroundAutomaticDeliveries` and `delegateBackgroundPeekDeliveries` count those source-specific deliveries, while `delegateBackgroundDeliveryOverlaps` counts unique stable job IDs observed through both. A terminal legacy response with `details.delivery: "automatic-queued"` is guidance only and is excluded because its queued message supplies the handoff. Stable job/run identities prevent either copy from adding another execution, outcome, truncation, or routing record. Historical reports use `Delegated results: N run(s)` and `Truncation: original report truncated`; older markers remain readable. The display delimiter `\n\n---\n\n` is never parsed because parallel handoffs use it internally. Older messages without details receive only a one-report fallback.

Unknown-argument blocks are recognized only when `isError` is true and the result text has the strict `Tool "…" does not support argument "…". Remove it and retry.` shape. Tool and argument names are never emitted.

Read-only review lifecycle counters cover clean snapshot retirements, same-snapshot continuations, and WIP/HEAD refresh attempts and outcomes. Worktree summaries used for this correlation expose the bounded source snapshot base; legacy results with older projection fields remain parseable, but those harness-policy fields are not emitted or measured.

## Routing and ratios

`routes` contains unique `routedTasks`: runs with both a route and recorded child usage. Each route reports tasks, turns, input/output usage, cost, and relative cost. `childTurnsPerTask` and `childCostPerTask` divide by `routedTasks`, not all delegated tasks or report copies.

Other ratios are `cacheHitRatio`, `delegateHandoffBytesPerTask`, `delegateTruncationRate`, and `delegateContinuationRate`. Cohort ratios are recomputed from summed totals, never averaged from per-session ratios.

## Privacy and interpretation

Output omits paths, prompts, tool arguments/results, task text, handoff bodies, and compaction summaries. Short session hashes are local correlation IDs, not anonymity guarantees. Provider usage is reported as recorded; elapsed time is the active-ancestry wall-clock span.

Metrics describe observed cost and reporting, not correctness. Compare cohorts only when task shapes are comparable.

## Task outcome episodes

The schema is `session-metrics/v8`. In addition to the existing metrics, every
session has an aggregate `episodeCohorts` object with `all`, `byShape`, and
`byLanguage` buckets. Shapes are only tool-pattern observations:
`analysis-only`, `mutation-unvalidated`, `mutation-validated`, `operations`,
and `other`. Language buckets are `english`, `russian`, `mixed`, and
`unknown`; a missing immediate reaction remains unknown rather than being
inferred from task text.

Episodes are derived only from the active ancestry. A persisted todo epoch
starts when unfinished work appears and remains open through steering and
follow-up turns. `done`, `dropped`, `blocked`, `replace`, `remove`, and
`clear_done` have distinct handling: only `all-done` is plan completion;
`dropped-only`, `mixed-terminal`, `superseded`, and `removed` are not
completion. A blocked or unfinished leaf is observation-censored. Sessions
without a reconstructable todo state use a no-todo agent-run fallback; it
reports `absent` or `unavailable`, never a fabricated plan result. Terminal
assistant text is evidence for `inferred-settled`; a tool-use tail is
`censored`.

Validation facets count attempts and retries independently for lint, test,
typecheck, format, and aggregate check. A successful validation before a later
successful mutation is `stale-after-later-mutation`. Commit, amend, merge, and
push attempts are correlated with their results. Delegate/provider failures
remain separate from parent recovery effort, which counts later parent turns
and tool calls and may connect to inferred settlement or observed verification.
These are operational proxies, not semantic correctness judgements.

Disposition classification is local and deterministic. Only the immediate
next active-ancestry user turn is considered; inquiry or ambiguous turns are
never skipped. Rules support English, Russian, and mixed messages with
`revise` taking precedence over acceptance, then `accepted`, `advance`,
`inquiry`, `new-task`, and `unknown`. Phrase shape, negation, interrogatives,
and conditionals prevent traps such as approval questions, `по-хорошему`, and
conditional future failures from becoming approval or advancement.

Per-episode records are intentionally opt-in:

```bash
bun run session:metrics -- summarize ~/.pi/agent/sessions --episodes
bun run session:metrics -- compare --baseline ./before --comparison ./after --episodes
```

Without `--episodes`, output is aggregate-only. With it, each session includes
an `episodes` array identified only by a one-based per-export `ordinal`. Records
contain bounded enums, counts, durations, booleans, language buckets, and
missing/unknown denominators. They do not contain prompts, task or user text,
paths, filenames, tool arguments/results, commands, branches, remotes,
transcript bodies, ticket IDs, or new stable identifiers. The existing
documented top-level local `sessionId` is unchanged and is not an episode ID.

This is offline derivation from existing JSONL; it adds no runtime event stream,
form, prompt, model judge, or external classifier. Historical two-reviewer
holdout evidence and the post-implementation 50-episode evaluation remain
pending; this implementation does not fabricate those results.
