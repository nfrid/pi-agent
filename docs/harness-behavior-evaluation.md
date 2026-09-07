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
passes `skills:["<absolute T>/SKILL.md"]` to `delegate`, substituting the real
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
`delegate.modelCatalog.luna-low` entry, including `relativeCost: 1`, `useFor`,
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
| pending | pending | 1–9 | pending | pending | pending |

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
- Compaction is **blocked/not exercised**: the baseline compact response was
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
