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
and `avoid`; do not modify global configuration or invent a mock catalog.
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
| pending | pending | 1–5 | pending | pending | pending |

Do not fill pending cells with invented baselines or results. If execution is
impossible, mark **blocked**, state the missing local capability, and retain no
secrets in the evidence.

## Recorded smoke check

On 2026-09-05, commit `2fb6db57` with delegate config fingerprint
`9e5ee875f120` passed a real child-launch smoke check using `gpt-5.6-luna`,
`low` thinking. The child read an explicitly selected synthetic skill,
reported two nonempty fixture lines, and successfully called bash with a
`description`. The fixture remained unchanged; no tool errors occurred.
Elapsed time was 16.8 seconds. The check used `buildChildArgs` and the actual
Pi CLI, not the parent `delegate` scheduling API. This verifies child loading
and bash parity, not the complete five-case evaluation, which remains pending.
