# Delegation

The delegate extension runs focused child agents using user-owned model routes. Parent-agent shell and repository access are unaffected by delegation settings.

## Always-async workflow scheduling

Normal model-facing delegation always schedules work and returns immediately. A fresh node supplies one stable logical `id` and an exact `route`; a continuation supplies `continue` and creates the next immutable attempt (`impl@1`, `impl@2`, …). Use `after` to bind exact dependency attempts and `inputs` to pipe symbolic reports, metadata, named views, or branch/snapshot references without copying them through the parent. A missing or invalid required input becomes a terminal `blocked` attempt with a bounded reason.

Register `delegate_wake` as a one-shot subscription before settling when work gates the next decision. It binds exact attempts and returns immediately. Select only the compact evidence the parent needs; the runtime queues delivery while the parent is busy and wakes an idle parent once. Send one concise waiting status and settle—do not poll with `delegate_jobs`. `delegate_jobs` is metadata-only status plus bounded feedback and cancellation; it never waits, consumes a report, or replaces a wake rule.

A fresh node must choose an exact configured route. A continuation inherits the persisted route, scope, worktree, and access mode when no route is supplied; an explicit replacement must be another valid exact route. Dependencies and wake rules never choose or escalate routes. Branch review and integration remain parent-owned.

### Compact recipes

- **Fan-out/fan-in:** schedule `scan-a`, `scan-b`, and `scan-c`; schedule `synthesis` with `after: ["scan-a", "scan-b", "scan-c"]` and symbolic report `inputs`; wake only on `synthesis`.
- **Implementation → review:** schedule writable `impl`; schedule `review` after `impl` with `inputs: [{"node":"impl","include":["report","branch"]}]`, referring to the exact symbolic branch; wake on review and branch availability.
- **Hidden exploration:** schedule broad `explore`, pipe its symbolic report into focused `plan`/`impl`, and deliver only that conclusion to the parent—never dump the exploration into parent context.
- **Continuation:** after review feedback, `continue: "impl"`, pipe the reviewer report, and let the runtime preserve the original route and worktree.
- **Do not delegate:** keep short edits, obvious check loops, and tasks needing repeated parent judgement in the parent.

## Route selection

Every fresh delegated task supplies one exact `route` key from `delegate.modelCatalog`. A continuation reuses its persisted route when omitted and may switch only by supplying another complete route key. Parallel tasks may share a top-level route or select routes independently.

Each route binds one provider, model, and thinking level. Selection is prose-driven: the orchestrator matches the task against each route's `useFor` and `avoid`, both required. `relativeCost` is the only number. It is a usage-drain prior rather than a quality score, and it orders the displayed catalog cheapest-first; it is not a global escalation ladder. Unknown routes fail rather than silently substituting.

Choose a service class before an effort level. The configured catalog uses Luna for bounded value work, Terra for interactive work with an explicit wall-clock objective, and Sol for maintainer judgement. Escalate effort within that class. Crossing from Luna to Terra is a latency decision, not the automatic next step after a difficult Luna task; crossing to Sol means the task needs judgement about what good work is, not merely more compute.

Configured relative costs are workload-shaped priors, not universal constants. Replace them with comparable local usage or credit measurements when enough routed tasks have accumulated; provider-reported actual cost remains the authoritative session metric.

There is deliberately no quality metric. One scalar cannot separate competences that vary independently — cost versus latency, breadth of correctness checking, and judging whether a diff overclaims are different axes. A catalog globally ranked by supposed quality would make routes unreachable under "cheapest route that is good enough" while their prose insists they are the right choice.

```json
{
  "delegate": {
    "modelCatalog": {
      "luna-medium": {
        "provider": "openai-codex",
        "model": "gpt-5.6-luna",
        "thinking": "medium",
        "relativeCost": 3,
        "useFor": "Bounded value work: verify one named invariant over at most three named files, or implement a localized change against a failing test with the check command given.",
        "avoid": "Open-ended review, deciding what to look for, or work spanning subsystems."
      }
    }
  }
}
```

Keep `useFor` and `avoid` in concrete task shapes rather than adjectives. "Strong repository understanding" cannot be matched against a task; "verify one named invariant over at most three named files" can.

The compact routing table is included in the parent system prompt when the delegate tool is available. Delegated children do not receive orchestration instructions.

## The report contract

A child is asked to report in named sections. Only `Outcome` and `Conclusion` are required; the rest appear when there is something to put in them, which on a small task is often none of them. Requiring all of them would buy padding from a cheap route rather than evidence.

```text
Outcome: done | partial | blocked | failed
Conclusion: the answer, or what you completed
Evidence: file:line, checks run and what they reported
Risks: material risks left unresolved
Blocked: the one question the parent must answer
```

`Outcome` exists because a process exit code cannot express it. A child that finished 60% of its task and said so honestly exits 0 exactly like one that finished, so without a stated outcome the parent has to read prose to tell the two apart, or build on partial work and find out later.

Evidence holds both citations and validation. Models are poor confidence meters, and a claim of certainty cannot be checked, whereas `src/cache.ts:212` and a command's output can be. Changed paths come from worktree metadata, not a child report.

For broad work, a child should stop early and return partial findings rather than consume its whole runtime without a report. The parent extracts the bounded outcome, conclusion, evidence, risks, and blocker into the handoff envelope before allocating any body, so these fields survive truncation.

## Questions back to the parent

A child that cannot settle something itself — the task contradicts what it found, or the call is the parent's to make — stops and ends its report with a `Blocked:` line holding one question. The parent answers by continuing that child, whose session, worktree, route, and scope are all intact.

For normal workflow calls, the parent remains available while children run. `delegate_jobs feedback` still queues one bounded message for a queued or running child at its next safe checkpoint; it does not interrupt an in-flight tool call, change the route or isolation, or bypass the worktree boundary. If a child settles first, use its explicit wake or a continuation for recovery.

`Blocked:` is extracted into the handoff envelope rather than left in the body, so it sits next to the continuation token and survives truncation — a question that reaches the parent without its answer route is no use. Everything a default and a stated assumption can cover stays a default and a stated assumption.

## What the parent sees

Every run contributes an envelope — process status, outcome, conclusion, continuation, blocker, artifact, worktree metadata, evidence, risks, and truncation — before any report body is allocated. The original child report is then appended as the body and straightforwardly byte-truncated if necessary. Small duplication between the envelope and body is intentional: it keeps the handoff simple and preserves the original report when it fits.

The safety bounds are 12 KiB for one result, 8 KiB per task in parallel, and 50 KiB for a parallel aggregate. They bound parent context; they do not promise savings. If mandatory envelopes alone exceed a bound, bodies are omitted rather than dropping conclusions, continuations, or other metadata.

An exact-output artifact is created only when the parent handoff genuinely omits or truncates that original report. A report that fits does not get an artifact merely because its fields also appear in the envelope.

## Schema-driven results

A delegate call may include a `result` contract. Contracts are scoped to that
invocation only: a continuation does not inherit the prior call's contract.
Omit `result` on a continuation to return to the legacy prose contract, or
supply a new task-level/top-level contract explicitly. The contract is
independent for every parallel task; a top-level `result` is the shared default
and a task-level `result` replaces it. A contract uses the compact `shape`
form, which is the complete agent-facing result API:

```json
{
  "result": {
    "shape": {
      "outcome": ["done", "partial", "blocked"],
      "summary": {
        "$optional": { "$type": "string", "maxLength": 500 }
      },
      "findings": [{
        "title": "string",
        "severity": ["low", "medium", "high"]
      }]
    },
    "projection": ["/outcome", "/findings/*/title"]
  }
}
```

Primitive strings (`string`, `number`, `integer`, `boolean`, and `null`) name
types. Object fields are required by default. A one-item array declares a
homogeneous list, while an array of two or more same-typed JSON literals declares
an enum. Nest those forms to declare a list of enum values. An exact
`{"$optional": shape}` wrapper makes one object field optional. A `$type`
descriptor adds supported constraints, such as
`{"$type":"string","minLength":1,"maxLength":500}`. Ordinary shape-object
keys beginning with `$` are reserved for these operators. To use a safe
`$`-prefixed result property, use the explicit object descriptor form, for
example `{"$type":"object","properties":{"$metadata":"string"}}`.
The dangerous names `__proto__`, `constructor`, and `prototype` remain
rejected. Shapes are expanded deterministically into one closed bounded
normalized representation used for child registration, validation, projection,
and artifacts; JSON-schema syntax is an internal transport detail, not a
parent-call compatibility form.

Paths use canonical JSON-pointer-like syntax: `/` means the complete result,
otherwise each segment is a declared object property. Use `projection: "all"` as
shorthand for `projection: ["/"]`; explicit path arrays, including `["/"]`,
remain supported. `~0` and `~1` encode `~` and `/`. Empty, `.`, `..`, numeric
array indexes, arbitrary JSONPath, and bad
escapes are rejected. Numeric object-property names are allowed when declared;
array indexes must use `*`, not a numeric segment. The only wildcard is `*`,
and it may select an array's items (`/findings/*/title`). A named view cannot
use `/`, because that would expose the complete result. Projection paths select
the compact parent completion; named view paths select separate JSON artifacts.
The full result is never copied into parent content or enumerable delegate
details. Human-facing delegate details, job snapshots, status surfaces, and
dashboard transcript events carry only the bounded parent-visible projection;
when its aggregate value budget cannot fit, they set `valueOmitted` and render
an explicit unavailable notice. The complete validated result remains
owner-session artifact-only (including named views), so these UI bounds never
weaken artifact redaction.

The global bounds are 16 KiB normalized-schema bytes, depth 8, 128 schema
nodes, 64 array items, 4,096 Unicode characters per string, 64 KiB result
bytes, 32 projection
paths, 8 KiB projected bytes, and 16 named views. Schema/path errors are
reported before child setup or launch. The child receives a dynamic terminating
`delegate_result` tool and must call it exactly once as its final action; JSON
in prose is not a structured result. If the first agent turn ends cleanly without
that call, the child extension sends one hidden bounded follow-up in the same
process/session; no follow-up is attempted after any result call, and the
original hard timeout remains authoritative. Parent settlement validates the captured
tool details once. Missing/malformed channels, wrong types, missing required
properties, extra properties, enum violations, and limits make the run
non-success with bounded validation errors.

A valid result is stored as an immutable owner-session `delegate-output` JSON
artifact. Only selected projections and lifecycle metadata appear in the
parent envelope. Each named view is stored separately and registered against
the full artifact handle in the owner session. The storage layer verifies
that the selected bytes equal the declared source path; callers cannot write an
arbitrary registry mapping. A source/name mapping is non-shadowable: conflicting
append-only entries fail closed rather than remapping an existing view. Forward it with
`handoffFrom: { "handle": "...", "view": "evidence" }`; the harness verifies
current-session ownership and the registry, then frames only that view as
untrusted evidence. Omitting `result` preserves the legacy prose report and
artifact behavior exactly.

### Failed-run lifecycle contract

Every errored, aborted, or timed-out run has a harness-authored `lifecycle`
projection. Its `reason` is one of the stable observed codes
`user-cancellation`, `queued-cancellation`, `timeout`,
`child-nonzero-exit`, `provider-runner-error`, `setup-failure`,
`lifecycle-cleanup-failure`, `child-result-invalid`, or `unknown`. These codes
report only what the harness observed; they do not infer a provider-specific
cause or retryability. Child prose and child structured-result fields cannot
set or override the projection.

The projection contains exactly one actionable diagnostic: complete bounded
text in `diagnostic`, or an owner-session exact `diagnosticArtifact` when the
text exceeds the 2 KiB inline diagnostic cap. A stale/non-owner or failed
publication path may instead expose a separately bounded `diagnostic` fallback
with an explicit exact-diagnostic-unavailable marker. Diagnostic capture is
bounded at 64 KiB and
child stderr is only used as a bounded child-exit diagnostic; raw stderr is
never copied wholesale into the public contract. UTF-8 byte bounds preserve
multiline and Unicode text without cutting an inline diagnostic in the middle.

`continuationUsable`, `writableBranchRetained`, and
`readOnlySnapshotRetained` are factual booleans derived from the durable
session/worktree records. A fresh setup failure or removed resource is never
reported as retained; a resumed setup failure may truthfully report the
worktree still retained by its continuation session. A read-only diagnostic
checkout and a retired read-only snapshot both count as read-only recovery
resources until removed. The same projection is rendered for single and
parallel results and for legacy job completion and inspection;
missing or invalid structured child results receive the same contract. Invalid
structured runs expose bounded harness validation/lifecycle diagnostics only;
when the one missing-channel repair also ends without a result, that diagnostic
may include a clearly labelled, UTF-8-bounded final-prose recovery excerpt.
Structured result fields and ordinary child prose are never fallback channels.

## Read-only delegates

A read-only delegate gets `read`, `bash`, `grep`, `find`, and `ls`, and is told in its prompt to inspect and report rather than edit. This is an intent signal, not an enforced boundary: the child has an ordinary shell and can do everything any agent with a shell can do. Use it when you want an answer, not a change.

## Writable delegates

`allowWrites: true` gives the task `edit` and `write` alongside the shell, and runs it in its own git worktree on a fresh `pi/<task-name>` branch under `.worktrees/`. Parallel writable tasks therefore never collide, even on the same files — that, not security, is what the worktree is for.

Setup follows the repository's native Git worktree semantics:

- `git worktree add` honors the configured `core.hooksPath`, including its checkout/setup hooks;
- the harness never symlinks or copies repository-local dependencies, build directories, or predefined `.env` files, and never runs an implicit install;
- `.worktrees/` is added to `.git/info/exclude`, never to the tracked `.gitignore`.

For a project that needs local setup, configure an ordinary idempotent
`post-checkout` hook. It runs in the new child checkout, so its generated or
ignored outputs remain child-local:

```sh
#!/bin/sh
# Save as .githooks/post-checkout, chmod +x, then configure:
# git config core.hooksPath .githooks
set -eu
mkdir -p node_modules/my-tool .project-build
[ -f node_modules/my-tool/README ] || printf 'local setup\n' > node_modules/my-tool/README
```

Hook code is project code executed with the repository user's command and
filesystem privileges; review and trust it just as you would other checkout
commands. Hooks may materialize dependencies or generated configuration in
each worktree while reusing package-manager or language-tool caches in their
normal user cache locations. Do not share mutable repository-local directories
between worktrees, and do not create secret-bearing environment files without
an explicit project policy.

By default (`from: 'wip'`) the parent's uncommitted work — the tracked diff plus untracked, non-ignored files — is reproduced inside the worktree, so the child sees the repository as you see it. `from: 'head'` starts from the last commit instead. Hook-created ignored files are setup state, not source snapshot content: exact source snapshots come from Git commits and the carried WIP commit, and snapshot rehydration reruns the native hook instead of restoring ignored files.

The carry lands as its own commit rather than as pending changes. That buys two things: the child starts on a clean tree, so its own commits describe only its own work, and the parent can be shown `carryCommit..branch` on review instead of a diff with its own uncommitted changes mixed into what it is judging. `changedPaths` counts only what the child changed, for the same reason.

The child is asked to commit as it goes and told explicitly not to merge, rebase, push, or switch branches. Anything it leaves uncommitted is committed for it when the run ends, so the branch is always the complete deliverable. Synthetic carry and finish commits suppress commit hooks deliberately; ordinary checkout/setup hooks still run when a worktree is created or rehydrated. Hook-created ignored setup files are never part of the branch's source snapshot.

A continuation reuses its original worktree, working directory, route, and scope, and must repeat `allowWrites: true`. If a worktree cannot be created — no repository, or git refuses — the task still runs writably in the parent checkout and says why.

`scope` is advisory in both directions now. It tells the child where the work is expected to land; nothing enforces it.

## Caller-provided worktrees

A fresh delegate may provide `worktreePath` with an absolute path to an existing
Git linked worktree. This is an explicit opt-in; isolation defaults remain
unchanged when it is omitted. The harness validates that the path is a
registered worktree (not merely a directory containing `.git`), belongs to the
same repository identity as `cwd`, is not the requested checkout, is attached
to a branch, has no in-progress merge/cherry-pick/rebase, and is clean of
tracked and non-ignored untracked changes. It also refuses a path or branch already held by another delegate record;
validation and first record publication are serialized by an atomic claim. The
existing branch tip is the source snapshot; `from`/`base` cannot be combined
with `worktreePath`. Before writable finish-time Git writes, the harness repeats
repository, registration, canonical non-symlink path, and symbolic-branch
validation under the same path lock.

The resulting record is explicitly caller-owned. The harness does not create a
nested checkout or branch, carry WIP, remove/prune the checkout, delete its
branch, or merge it into the parent. Writable runs may commit their work (and
lifecycle cleanup may commit leftover writable edits); read-only cleanup never
commits and reports a run that modified the caller path without changing those
files. `delegate_branches review` remains available as bounded evidence from
the recorded starting tip, while `merge` is refused with instructions to
manage the branch in its own checkout. `drop`/`/delegate-worktrees ... drop`
only releases the harness record and retains both checkout and branch. Active
caller-owned records cannot be released; only pre-launch rollback may release
one after setup never launched a child.

A continuation reuses the recorded caller path, branch, repository, and last
known tip. It cannot replace `worktreePath`, refresh it, or silently fall back
to a nested checkout; the path must still be registered, clean, on the same
branch and tip, and owned by the same repository. If the caller changes or
removes it, setup fails with a continuation rather than touching another
checkout.

## Legacy and human compatibility controls

The normal model surface has no foreground/background choice, no `peek`, and no automatic completion injection. Older persisted rows and human/operator controls may still use those terms while compatibility is retained: `delegate_jobs` can inspect bounded metadata, send feedback, request a checkpoint, or cancel; the dashboard and `/delegates` remain the full historical inspection surfaces. These controls do not consume wake payloads.

`/pause` pauses the parent and every active delegate at provider-safe boundaries. In-flight provider responses and tool calls finish first; no new provider request starts after a participant reaches the pause gate. The footer and dashboard show `Paused` for the parent alone or `Paused (with N delegates)` after all enrolled delegates acknowledge the gate. While pausing or paused, wake delivery is retained rather than steering the parent. `/continue` releases the parent and delegates, then delivers retained wake entries. New delegate calls are rejected until the runtime resumes.

## TUI inspection bounds

The delegate rail keeps all queued/running and failed, timed-out, or aborted
rows visible. Successful history is capped at eight rows and the rail adds an
explicit hidden-count line rather than letting old completions push active work
off screen. Expanded parallel calls/results use the same policy for successful
runs; the full run count and diagnostics remain in the result metadata.

Expanded results separate `Result`, `Lifecycle / recovery`,
`Continuation / worktree`, `Runtime`, `Usage`, and `Transcript` sections.
Long task, result, diagnostic, activity, and worktree fields carry an explicit
truncation marker. Use the normal configured `app.tools.expand` binding for the
bounded details view, then use:

```text
/delegate-transcript                 # latest delegate result
/delegate-transcript <name-or-token> # latest matching result
```

In TUI mode this opens a supported Pi `ctx.ui.custom({ overlay: true })`
scrollable modal (`↑↓`, `PgUp/PgDn`, `Home/End`, `Esc`). It shows the bounded
transcript Pi retained for the run; structured result payloads and private child
thinking are intentionally not copied into public details. In RPC/headless
modes the command falls back to a bounded notification because Pi does not
provide a terminal modal there.

## Usage state

Usage refreshes are process-level and keyed by provider plus query identity, so
fresh state is reused when Pi switches/reloads sessions and concurrent session
refreshes coalesce. Window identities (`limitId`/`limitName`) remain separate;
they are selected for the current model only at display time. The footer labels
each window (`5h`, `wk`, or its reported duration) and shows its reset time
when available. A five-minute periodic refresh remains the freshness bound;
manual/model-change/settled refreshes can force an update.

## Integrating the result

A finished writable run reports its branch, its base commit, and the paths it changed. Nothing bespoke carries the work back: it is a git branch, and the orchestrating agent is expected to integrate it itself. The `delegate_branches` tool is the fan-in counterpart to parallel worktrees — it accepts a worktree id or a continuation token:

```text
delegate_branches list                    # current parent-session records
delegate_branches list scope=all           # all retained repository history
delegate_branches review <id>             # the child's commits, stat, and diff
# review selectors: summaryOnly, paths=[...], patchBudget=<chars>; selectors report omitted paths/truncation
delegate_branches merge <id>              # integrate into your checkout
delegate_branches drop <id>               # delete the checkout and the branch
```

`list` defaults to records created or touched by the current parent Pi session; `scope: all` is the explicit recovery view and includes legacy records. `review` measures from the child's own starting point, so carried parent work never appears as the child's. `summaryOnly` returns provenance, commits, stat, and bounded path evidence without patch bodies. `paths` accepts exact safe repository-relative paths, while `patchBudget` caps patch characters; every bounded view reports active selectors, total/matched/omitted paths, and patch omission. `merge` integrates only the child's commits after `workBase`, not the carry snapshot. For `from: 'wip'`, it therefore preserves non-overlapping dirty parent state while refusing to proceed when a child-edited path is also dirty in the parent. It either lands or leaves the checkout exactly as it was: a conflict is aborted rather than parked, because an agent working on from a half-merged tree makes a worse mess than one told to resolve deliberately. Caller-owned records are review-only: merge is refused and drop releases only the harness record, never the checkout or branch. Harness-managed `drop` refuses unmerged work without `force`.

`/delegate-worktrees` inspects and cleans up from the parent session:

```text
/delegate-worktrees                              # list
/delegate-worktrees <id-or-continuation>         # show branch, base, changed paths
/delegate-worktrees <id-or-continuation> remove  # drop the checkout, keep the branch
/delegate-worktrees <id-or-continuation> drop    # drop the checkout and the branch
```
