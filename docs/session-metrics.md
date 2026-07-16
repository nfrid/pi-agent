# Session metrics

`scripts/session-metrics` reads Pi session JSONL and emits aggregate context and usage measurements. It reconstructs the ancestry of the active leaf, so abandoned branches do not inflate totals.

## Usage

```bash
npm run session:metrics -- summarize ~/.pi/agent/sessions \
  --min-todo-calls 1 --limit 20

npm run session:metrics -- compare \
  --baseline /path/to/baseline-sessions \
  --comparison /path/to/comparison-sessions \
  --min-todo-calls 1
```

Repeat `--baseline` or `--comparison` to combine multiple roots. `--limit` is applied after filtering to each side of a comparison.

## Output

The versioned JSON includes per-session aggregates, cohort totals, medians, and comparison-minus-baseline deltas for:

- user and assistant turns;
- todo calls and results;
- compactions and elapsed ancestry time;
- provider-reported input, output, cache-read, and cache-write usage; and
- peak request context.

The cache-hit ratio is weighted from summed tokens as `cacheRead / (input + cacheRead + cacheWrite)`.

## Privacy and interpretation

Output omits source paths, prompts, tool arguments and results, file content, and compaction summaries. Session IDs are short content hashes intended only for local correlation; they are not anonymity guarantees. Provider usage is reported as recorded, and elapsed time is wall-clock ancestry span rather than active working time.
