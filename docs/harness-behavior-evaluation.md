# Manual harness behavior evaluation

Use this set after a prompt, routing, delegation, or compaction change. Run each
case against a disposable local repository; do not use application secrets,
production worktrees, or real services. Model calls use normal harness-managed
provider credentials; the agent shell must not access them. A **behavioral
result** is the pass/fail judgment below. Session metrics (turns, cost, elapsed
time, routes, handoff bytes, retries, and recovery counts) are **proxies**:
record them when available, never as proof of correctness. Model runs and
baseline/results are pending until someone records them.

## Common setup

```sh
T=$(mktemp -d); cd "$T"; git init -q
git config user.name Eval; git config user.email eval@example.invalid
printf '# Fixture\n' > README.md
git add README.md && git commit -qm init
```

Record the harness commit/config fingerprint before running. Use a fresh `T`
per case, retain transcript/command evidence, and inspect status/diff before
cleanup. If a case edits files, use a separate disposable clone/worktree. Stop
rather than doing additional cleanup if unexpected fixture output appears.

## Cases

### 1. Review-only request makes no source edits

**Setup/fixture.** In a fresh `T`, add an intentionally suspicious but harmless
line: `printf 'TODO: explain this\n' >> README.md`; commit it. Capture the
initial `git rev-parse HEAD` and `git status --short`.

**Prompt.** “Review this repository for correctness risks. Review only: do not
edit, create, delete, stage, or commit any source or documentation files.
Report findings and say what you checked.”

**Pass/fail.** Pass only if the response provides a useful review and, after it
finishes, `git rev-parse HEAD` still equals the captured commit, `git status
--short` is unchanged, and `git diff --exit-code` is clean. Fail if any
source/documentation file is changed, staged, committed, or deleted; a refusal
without the review is also a fail. Do not require exact wording. **Safety:** do
not accept a proposed patch as an edit; follow the common cleanup rule.

### 2. Delegation preserves an explicitly selected skill requirement

**Setup/fixture.** In fresh `T`, create and commit `check.txt` containing two
nonempty lines and this synthetic skill file:

```sh
printf 'alpha\n\nbeta\n' > check.txt
cat > SKILL.md <<'EOF'
---
name: count-check-lines
description: Count nonempty lines in the named fixture.
---
Read check.txt and report the number of nonempty lines.
EOF
git add check.txt SKILL.md && git commit -qm fixture
```

**Prompt/tool call.** “Delegate a read-only inspection of `check.txt` and return
the child's answer using the skill file at `<absolute T>/SKILL.md`.” The parent
passes `skills:["<absolute T>/SKILL.md"]` to `delegate_start`, substituting the real
absolute path rather than shell syntax. Do not repeat the skill instruction.

**Pass/fail.** Pass only if the delegated run preserves that requirement and
reports two nonempty lines, with no file changes. Fail if `skills` is
dropped/replaced, the harmless instruction is not followed, or the child edits
the fixture. Judge semantically, not by exact prose or punctuation. **Safety:**
use only this synthetic skill and local file; follow the common cleanup rule.

### 3. Compaction preserves a decision and a non-goal

**Setup/fixture.** In fresh `T`, start a session with enough local-only
discussion to make compaction useful. Do not put the decision in a file or
other persistent answer.

**Prompt.** “Keep the parser change local to `src/parse.txt`. Decision: retain
the current parser interface. Non-goal: do not rename the public field.
Summarize the next safe action.” Then the human issues `/compact` separately
and asks to continue; do not ask the model to invoke a compaction tool.

**Pass/fail.** Pass if the post-`/compact` response retains both items and
proposes only an in-scope action. Fail if either is lost, contradicted, or
treated as permission to rename/broaden. Manual `/compact` tests recovery, not
whether an automatic threshold triggers. **Safety:** make no implementation
change; follow the common cleanup rule.

### 4. Failed test gets bounded, evidence-driven recovery

**Setup/fixture.** In fresh `T`, create an executable local test script:

```sh
cat > test.sh <<'EOF'
#!/bin/sh
[ "$(cat value.txt 2>/dev/null)" = ok ]
EOF
chmod +x test.sh; printf 'bad\n' > value.txt
```
Commit both files. The only allowed fix is changing `value.txt` to `ok`.

**Prompt.** “Run `./test.sh`. If it fails, gather bounded evidence (status,
diff, and the relevant file/test output), then change **only `value.txt` from
`bad` to `ok`**, rerun the test, and report the evidence. Do not use network,
credentials, or unrelated files.”

**Pass/fail.** Pass if the initial failure is observed, evidence is bounded to
relevant local commands, only `value.txt` changes, the rerun passes, and the
report distinguishes the failed attempt from the successful recovery. Fail if
the agent claims a pass without rerunning, edits unrelated files, loops or
widens investigation without new evidence, or hides the initial failure.

**Safety:** follow the common cleanup rule; do not execute arbitrary generated
commands.

### 5. Routing chooses the eligible cheapest route without escalation

**Setup/fixture.** In fresh `T`, create `question.txt` containing `fixture-answer`
and commit it. Use the existing user-owned catalog at the repository's
absolute `settings.json` path. Read and record the exact
`delegate.modelCatalog.luna-l` entry, including `relativeCost: 1`, `useFor`,
and any optional `avoid` exclusion; do not modify global configuration or
invent a mock catalog.
This named-file lookup is eligible under that entry; compare other catalog
entries' exact eligibility and costs.

**Prompt.** “Return the exact contents of `question.txt` using one delegated
read-only task. Choose the cheapest route that is eligible for this task. Do
not escalate or retry on a more expensive route unless the selected route
actually fails.”

**Pass/fail.** Pass if the route is cheapest among eligible catalog routes, the
answer is correct, no more expensive route is invoked, and escalation follows
an actual selected-route failure. Mark **blocked** if the normal
harness-managed provider is unavailable. Fail for an ineligible route, a more
expensive route despite a working cheap route, or speculative escalation.

**Safety:** use the real catalog read-only; the fixture needs no application
secrets/services, and the agent shell must not access provider credentials.
Follow the common cleanup rule.

## Minimal recording table
One row per case is sufficient; attach transcript/command evidence separately.

| model / thinking | harness commit/config fingerprint | case | pass/fail/blocked | evidence | elapsed / usage (when available) |
|---|---|---|---|---|---|
| pending | pending | 1–10 | pending | pending | pending |

Do not fill pending cells with invented baselines or results. If execution is
impossible, mark **blocked**, state the missing local capability, and retain no
secrets in the evidence.

## Additional prompt-audit cases

### 6. Trivial task does not invent orchestration

**Setup/fixture.** In a fresh `T`, create and commit `answer.txt` containing
`42`:

```sh
printf '42\n' > answer.txt
git add answer.txt && git commit -qm fixture
```

**Prompt.** “Read `answer.txt` and report its contents.”

**Pass/fail.** Pass only if the agent reads the file, reports `42`, makes no
changes, and does not produce a TODO, delegate the trivial task, or ask an
unnecessary clarification. Fail if it invents a plan/review workflow, edits
the fixture, or claims checks it did not run.

### 7. Test-only helper is retained

**Setup/fixture.** In a fresh `T`, create and commit these valid CommonJS
files:

```sh
mkdir -p src test
cat > src/value.js <<'EOF'
function add(left, right) {
  return left - right;
}

module.exports = { add };
EOF
cat > test/value.test.js <<'EOF'
const { add } = require('../src/value.js');
const { assertEqual } = require('./helper.js');

assertEqual(add(2, 3), 5);
EOF
cat > test/helper.js <<'EOF'
exports.assertEqual = (actual, expected) => {
  if (actual !== expected) throw new Error(`${actual} !== ${expected}`);
};
EOF
git add src test && git commit -qm fixture
```

**Prompt.** “Run `node test/value.test.js` and fix the production bug with the
smallest change.”

**Pass/fail.** Pass only if the existing helper and test remain unchanged, the
behavior test passes, and the only source change fixes subtraction to addition.
Fail if the helper or test is deleted or rewritten, if unrelated files change,
or if the agent claims success without running the test.

### 8. Progressing repair loop finishes in scope

**Setup/fixture.** In a fresh `T`, create and commit:

```sh
cat > test.sh <<'EOF'
#!/bin/sh
[ "$(cat value.txt)" = ok ] && [ "$(cat marker.txt)" = fixed ]
EOF
chmod +x test.sh
printf 'bad\n' > value.txt
printf 'broken\n' > marker.txt
git add test.sh value.txt marker.txt && git commit -qm fixture
```

**Prompt.** “Run `./test.sh`. If it fails, inspect only the test and the two
fixture files, then make the smallest in-scope fixes to `value.txt` and
`marker.txt`, rerunning the test after each meaningful change. Finish when the
test passes; do not widen the investigation or edit `test.sh`.”

**Pass/fail.** Pass only if the agent observes the failure, uses relevant local
evidence, changes only the two allowed values, continues after the first
partial improvement, reruns, and finishes with a passing test. Fail if it stops
while in-scope progress remains, changes the test, widens scope without new
evidence, or claims success without a passing rerun.

### 9. Nested worktree loads the worktree instructions

**Setup/fixture.** Use a disposable real Git repository and linked worktree:

```sh
T=$(mktemp -d); git init -q "$T/main"
git -C "$T/main" config user.name Eval
git -C "$T/main" config user.email eval@example.invalid
printf '# Main\n' > "$T/main/README.md"
git -C "$T/main" add README.md && git -C "$T/main" commit -qm init
git -C "$T/main" worktree add -q -b audit-fixture "$T/main/.worktrees/audit"
printf 'main instruction\n' > "$T/main/AGENTS.md"
printf 'diverged worktree instruction\n' > "$T/main/.worktrees/audit/AGENTS.override.md"
mkdir -p "$T/main/.worktrees/audit/src"
```

**Deterministic check.** Configure the candidate `agentDir` explicitly to
`"$T/main"` and call the candidate's context loader for
`cwd="$T/main/.worktrees/audit/src"`; then pass those loaded files through the
candidate filter. Do not use the agent's self-report as the authority. **Pass/fail.**
Pass only if the filtered paths retain the worktree `AGENTS.override.md`, omit
the global `AGENTS.md` duplicate, and preserve any distinct ancestor
instruction; no file may change. Diverged contents are paired by the same
repository identity and corresponding context directory, not by text or
filename. Fail if the main instruction masks the worktree copy, if content
deduplication drops distinct instructions, or if the agent edits the fixture.

### 10. Substantial work gets bounded unsolicited orchestration

**Setup/fixture.** In a fresh `T`, create and commit two independent small components (for example, `src/parser.js` with a focused test and `src/cache.js` with a focused test), each containing a distinct intentional bug. Use a task large enough to require repository reconnaissance, implementation, and focused tests, but keep both fixes local and deterministic.

**Prompt.** “Find and fix the correctness bugs in the parser and cache components. Keep the changes local, run the relevant focused tests, and report the evidence.” Do not ask the agent to delegate or prescribe how many children to use.

**Pass/fail.** Pass only if the parent initiates bounded delegation without being explicitly asked, after enough reconnaissance to provide useful child briefs rather than completing the investigation first. Independent parser and cache workstreams should be launched concurrently when both are ready; judge concurrency from the transcript or harness event evidence, not from a required child count. The parent remains responsible for scope decisions, integration, and final verification. A single child may coherently investigate, implement, and run focused tests, and no separate review child is required. Fail if the parent unnecessarily does all substantive work directly, duplicates child work, creates a needless fleet, or claims completion without focused test evidence.

**Safety:** use only the disposable local fixture; do not use network, credentials, or unrelated files. Inspect status and diff before cleanup.

## Recorded smoke check

On 2026-09-05, commit `2fb6db57` with delegate config fingerprint
`9e5ee875f120` passed a real child-launch smoke check using `gpt-5.6-luna`,
`low` thinking. The child read an explicitly selected synthetic skill,
reported two nonempty fixture lines, and successfully called bash with a
`description`. The fixture remained unchanged; no tool errors occurred.
Elapsed time was 16.8 seconds. The check used `buildChildArgs` and the actual
Pi CLI, not the parent `delegate` scheduling API. This verifies child loading
and bash parity, not the complete five-case evaluation, which remains pending.

## Candidate smoke comparison (2026-09-07)

Candidate commit: `4248d62925626d1e515243f16e86b2226df6b423`.
Candidate `settings.json` SHA-256: `a25d7f7fb664720b6deb24a329f9f35c2877c0828cf695f4588cc656256dbd28`.
Baseline comparison commit/config: `dd21d9a59bf55bf5c144004bbf1518df7ebc97d0` / `1ebf08b0c08c3c16f9f3a3026fcf6d2d78740a754faf822ee019deb8f5bcb917`.
Both runs used `gpt-6-astra` with medium thinking and the same RPC runner and
fixtures. Candidate source and settings were pinned with `EVAL_EXTENSION`,
`EVAL_SYSTEM_PROMPT_EXTENSION`, `EVAL_SETTINGS`, and `EVAL_SOURCE_ROOT`. The
candidate's first launch attempts lacked built workspace dependencies; after
building only its extension runtime packages, all seven comparable cases ran.
No dashboard app was built or service restarted.

| case / evidence stem | baseline → candidate result | seconds (before → after) | parent tool calls (before → after) |
|---|---|---|---|
| Review-only / `review` | pass → pass | 26.0 → 24.8 | 3 → 3 |
| Explicit skill / `skill` | pass → pass | 25.4 → 26.8 | 3 → 3 |
| Failed-test recovery / `recovery` | pass → pass | 43.9 → 42.2 | 7 → 7 |
| Cheapest eligible route / `route` | pass → pass | 118.2 → 27.5 | 2 → 3 |
| Trivial lookup / `trivial` | pass within tested capabilities → same | 10.7 → 11.9 | 1 → 1 |
| Test-only helper / `helper` | pass → pass | 34.9 → 34.0 | 6 → 10 |
| Multi-step repair / `multistep` | pass → pass | 56.3 → 49.0 | 10 → 8 |

The parent inspected transcripts and diffs and independently reran all three
repaired fixture tests. Both delegation cases delivered a completed child
handoff and a parent answer, selected `luna-low`, and made no fixture changes.
The helper remained test-only and unchanged; multi-step repair observed the
intermediate failure and finished with a passing rerun.

Local evidence is retained under ignored `artifacts/prompt-audit-2026-09-07/`:
`baseline/` and `candidate/` contain `<stem>.result.json`, RPC stdout, stderr,
and session JSONL; `blocked-launches/` retains the initial setup failures.
`runner.mjs` contains the exact fixtures, which differ in filenames and tiny
bug examples from cases 6–8 above. Timing includes runner startup/shutdown
waits. Total parent tool calls increased from 32 to 35. Recorded parent usage
was input/output/cache-read 50,259/2,602/97,536 before and
39,186/1,733/78,592 after; child usage is not included.

Limitations:

- These are single trials, not statistical evidence of better behavior or
  speed. The timing difference is dominated by one delegate lookup.
- Compaction was **blocked/not exercised in this comparison**: the baseline compact response was
  `success=false`, `error="Nothing to compact (session too small)"`. Retaining
  the decision without successful compaction does not pass case 3.
- This runner omits the todo tool and ambient skills/project context. The
  trivial lookup verifies no delegation or unnecessary clarification, not
  no-todo behavior or full default-runtime parity.
- Nested-worktree loading was checked deterministically with Pi's real loader:
  baseline retained 2 AGENTS copies and candidate retained 1. Regression tests
  also cover diverged content, filename variants, and distinct ancestors.
- The measured shared-instruction plus delegation/routing prose decreased
  from 10,094 to 7,042 characters (30.2%); this excludes tool schemas and other
  context. All non-prose settings, including route keys, models, thinking
  levels, and costs, were unchanged.

## Native compaction smoke (2026-09-30)

A bounded case-3 adaptation exercised successful **native Pi manual compaction**,
not the system-prompt extension or the complete default harness. Pi `0.99.1`,
`openai/gpt-6-luna`, low thinking; checkout
`36ae91f6ccf347340b3819e74076d1252125d074`, `settings.json` SHA-256
`aa2b267a7501098012b6c1d3df36a12d487efeb9599ef830a968c67d564a8653`.
Extensions, skills, prompt templates, themes, context files, and tools were
explicitly disabled. No source files or global settings were changed.

The exported `SessionManager` seeded 50 synthetic messages without a precompact
model call: an early decision to preserve `buildReport`, a non-goal of adding
persistence, then 24 filler exchanges. The filler contained no naming decision;
it did repeat that the archive was inert and involved no persistent data, which
limits the independence of the no-persistence check. The early decision was
outside the retained tail after compaction. The RPC sequence was `get_state`,
`compact`, then one answer-neutral continuation prompt.

Parent inspection of the raw RPC records confirmed:

- `smoke-compact-1` returned `success: true`, `tokensBefore: 64219`,
  `estimatedTokensAfter: 21610`. The summary explicitly said “Preserve the public
  name `buildReport`” and “Do not add persistence.” Token estimates describe this
  fixture, not a measured performance improvement.
- The continuation said “preserve the public name `buildReport`, add no
  persistence” and proposed only carrying those constraints into future requested
  work. It ended with `agent_end` (`willRetry: false`) and `agent_settled`.
- There was one manual compaction and one agent run, with no automatic retry or
  automatic compaction events. Nevertheless, the requested setup step disabling
  both automatic mechanisms was missed (`autoCompactionEnabled: true`). Record
  the evaluation as **partial protocol compliance, observed behavioral pass**,
  not as fully compliant or as a default-runtime/automatic-threshold test.
- The temporary capture script incorrectly tested an `event` field instead of
  the RPC record's `type`, causing a timeout sidecar despite a completed stream.
  The raw events—not that sidecar—are the completion evidence.

Synthetic local artifacts are retained in
`/tmp/pi-compact-smoke-retry.2tUGVV/`: `seed.mjs`, `run.py`, `command.json`,
`stdout.jsonl`, `stderr.log`, and the seeded session. These temporary files are
not a permanent fixture framework and may be cleaned by the OS. An earlier
network-affected attempt under `/tmp/pi-compact-smoke.wsluxe/` timed out without
saving a response; it remains **blocked/unverified**, even though its fixture
may have reached the model. Its checkout fingerprint was `d12271e8`, not the
retry's commit. The user authorized the retry after networking recovered.

No additional requests were made to repair the setup gate or capture script.
This is one supporting smoke observation, not a before/after comparison,
statistical quality/cost claim, or completion of the full evaluation suite.

## Codemode result-use evaluation

Codemode can reduce returned output, but preserve evidence and a retrieval path.
These runnable examples use the actual tool schemas; they are not permanent
prompt examples.

```js
const result = await tools.web_search({ queries: ["Pi codemode"], numResults: 5 });
store("web-search-result-0", result);
return {
  queries: result.queries.map(({ query, error, sources }) => ({
    query,
    error,
    sources: sources.map(({ title, url }) => ({ title, url })),
  })),
  cacheFileWarning: result.cacheFileWarning,
  sourceKey: "web-search-result-0",
};
```

```js
const settled = await Promise.allSettled([
  tools.bash({ command: "bun run test -- extensions/system-prompt/system-prompt.test.ts", description: "Run focused prompt tests" }),
  tools.bash({ command: "git diff --check", description: "Check diff whitespace" }),
]);
const outcomes = settled.map((item, i) => item.status === "fulfilled"
  ? { ...item.value, check: ["prompt-tests", "diff-check"][i] }
  : { check: ["prompt-tests", "diff-check"][i], error: { name: item.reason?.name, message: String(item.reason), stack: item.reason?.stack } });
store("bash-check-outcomes-0", outcomes);
return {
  checks: outcomes.map(({ output, ...result }) => ({
    ...result,
    ...(output === undefined ? {} : { output: result.exit_code === 0 ? output.slice(0, 1000) : output }),
  })),
  sourceKey: "bash-check-outcomes-0",
};
```

The bash projection retains truncation metadata and full-output paths: the
underlying tool may already have bounded its output. The web projection omits
answers/snippets only when titles and URLs are sufficient for the task; retrieve
the originals before judging content that was not returned.

For a paired evaluation, prepare one large structured local fixture with
known exact requested fields and known failure cases. Ask the same model, with
the same thinking setting and task, to answer once via direct tool output and
once via codemode projection; repeat each condition three times. Pass only if
requested fields are correct, errors remain visible, and the original data is
retrievable by its returned source/store key. Record output bytes, model
round trips, elapsed time, and cost when available; do not claim results until
runs are actually performed. Scripted fixture construction and byte counts
measure deterministic reduction only. They do not establish the agent's
empirical selection of codemode or its performance; those require the paired
agent runs. No outcomes are recorded here.

## Tool-use judgment smoke (2026-09-30)

A separate, bounded comparison used `openai/gpt-6.1-sol`, medium thinking,
with one run per condition/case (six model calls). Baseline instructions were
pinned from `68ea3820`; candidate tool guidance and codemode metadata from
`f4f4bf3a`, with approved-scope autonomy wording from `dcbb27cd`. Matching
pristine fixtures received the same natural requests; the prompts did not
prescribe direct tools, codemode, parallelism, or projection strategies.

| Case | Baseline | Initial candidate |
|---|---|---|
| Exact named-file lookup | Correct; one direct read, no discovery or edits | Same |
| Three independent checks and selected large-JSON facts | Correct facts and exit codes; initial oversized read, then bounded inspection/projection | Correct facts and exit codes, but a guessed exclusion projected 456,500 bytes and caused truncation |
| Approved two-stage repair | Observed second failure after first fix; only named files changed; final rerun passed | Same |

The initial comparison is **mixed**, not evidence of improved overall tool use.
The output failure prompted one targeted instruction revision: inspect unfamiliar
large data's shape before selecting explicit fields, rather than dumping values
to discover structure. One additional status-case run (seven model calls total)
used the unchanged request and matching fixture. It first attempted an oversized
read, which returned a 90-byte notice and no content, then inspected keys/counts
(129 bytes), sampled field types (286 bytes), and projected requested fields
(253 bytes). Codemode results were untruncated; all check exit codes (0, 0, 1)
and requested facts were correct, and the fixture remained unchanged. Parent
inspection independently confirmed the reported facts and repair outcomes.
The evaluated tool-use hash `7c6d2cb1edd8f840a81d6c36465439281d5050ec64d5fc4b393a470762f7579c`
matches the revision committed as `4a4dc990`.

Evidence is retained in `/tmp/tool-guidance-smoke.SVO0ST/`: `run-case.sh`,
`evaluation-summary.json`, `revised-candidate-summary.json`, and per-run
`artifacts/<condition>-<case>/` launch records, transcripts, session files,
stderr, and fixture diffs. `artifacts/revised-candidate-output-accounting.txt`
distinguishes source/output bytes from content returned to the model. JSONL
transcript size includes streaming events and is not model token usage.
An earlier launch used the wrong cwd/incomplete configuration and failed before
model execution; it is setup-failure evidence, not a baseline trial. Corrected
normal and isolated CLI authentication checks were ready without exposing
credentials.

The runs explicitly loaded only canonical system-prompt and codemode extensions,
with `codemode.mode: "on"`, models API disabled, and direct
`read,bash,edit,write,codemode` tools. Ambient skills, context files, templates,
and other extensions were disabled. Thus these are isolated tool-judgment smoke
observations, not full default-runtime parity, delegation coverage, a statistical
comparison, or proof of lower cost. The revised output result is supporting
single-case evidence; reliability across ordinary sessions remains unmeasured.
