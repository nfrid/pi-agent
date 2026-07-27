# Session metrics

`scripts/session-metrics` reads Pi session JSONL and emits aggregate context and usage measurements. It reconstructs the ancestry of the active leaf, so abandoned branches do not inflate totals.

## Usage

```bash
npm run session:metrics -- summarize ~/.pi/agent/sessions \
  --min-todo-calls 1 --limit 20

npm run session:metrics -- compare \
  --baseline /path/to/baseline-sessions \
  --comparison /path/to/comparison-sessions \
  --min-delegate-calls 1
```

The JSON goes to stdout, so pass `npm run --silent` when piping it into another tool; otherwise npm's own banner lands in the stream first. Repeat `--baseline` or `--comparison` to combine multiple roots. `--limit` is applied after filtering to each side of a comparison. `--min-todo-calls` and `--min-delegate-calls` both apply; use the latter to compare delegation-heavy cohorts.

## Output

The versioned JSON includes per-session aggregates, cohort totals, medians, and comparison-minus-baseline deltas for:

- user and assistant turns;
- todo calls and results;
- compactions and elapsed ancestry time;
- provider-reported input, output, cache-read, and cache-write usage;
- peak request context; and
- delegation counts and cost, described below.

## Delegation measurements

These answer what delegation costs the parent's context, which is the resource an orchestrating session runs out of first.

- `delegateToolCalls`, `delegateContinuationCalls`, `delegateParallelCalls` — calls made, of which continuations and parallel fans.
- `delegatedTasks` — tasks that actually ran, summed from each result's runs.
- `delegateRejectedCalls` — calls the tool refused before launching anything, such as invalid parameters. These are counted separately rather than as tasks, so a short refusal cannot flatter the per-task byte figure.
- `delegateWritableTasks` — tasks that ran with writes allowed, in their own worktree.
- `delegateHandoffBytes` — UTF-8 bytes of parent-visible handoff text, excluding the exact output preserved in artifacts and tool details.
- `delegateTruncatedTasks` — tasks whose body was cut to fit the handoff caps, read from the envelope's truncation flag and capped at the runs present.
- `delegateBackgroundStarts`, `delegateBackgroundDeliveries` — background jobs launched, and completed handoffs delivered back.

Background work is charged where the parent actually pays for it. A background call returns an acknowledgement naming the job, and the report arrives later as a `delegate_jobs` result, so the acknowledgement counts as neither tasks nor bytes and the delivery counts as both. Counting the acknowledgement instead would charge a task the cost of a receipt and never count what it sent back. A job delivered once and then peeked at again counts twice, because the parent was given both copies.

Ratios have one definition, applied identically to a session and to a cohort, so a cohort ratio is weighted by summed totals rather than averaged from per-session ratios: `cacheHitRatio` is `cacheRead / (input + cacheRead + cacheWrite)`, `delegateHandoffBytesPerTask` is bytes over tasks, `delegateTruncationRate` is truncated over total tasks, and `delegateContinuationRate` is continuations over calls.

## Privacy and interpretation

Output omits source paths, prompts, tool arguments and results, file content, delegated task text, handoff bodies, and compaction summaries. Session IDs are short content hashes intended only for local correlation; they are not anonymity guarantees. Provider usage is reported as recorded, and elapsed time is wall-clock ancestry span rather than active working time.

Delegation figures are diagnostic evidence, not a score. A process that exited cleanly is not proof of correct work; a continuation is often a deliberate correction rather than a failure; and a cheap route is not economical if it causes parent rework. Cohorts are only comparable when the underlying task shapes are.
