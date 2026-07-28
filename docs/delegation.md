# Delegation

The delegate extension runs focused child agents using user-owned model routes. Parent-agent shell and repository access are unaffected by delegation settings.

## Route selection

Every fresh delegated task supplies one exact `route` key from `delegate.modelCatalog`. A continuation reuses its persisted route when omitted and may switch only by supplying another complete route key. Parallel tasks may share a top-level route or select routes independently.

Each route binds one provider, model, and thinking level. Selection is prose-driven: the orchestrator matches the task against each route's `useFor` and `avoid`, both required. `relativeCost` is the only number. It is relative usage drain rather than a quality score, and its one job is to order the catalog cheapest-first so "climb a rung" means something. Unknown routes fail rather than silently substituting.

There is deliberately no quality metric. One scalar cannot separate competences that vary independently — breadth of correctness checking is a different axis from judging whether a diff overclaims — and a catalog ranked by it ends up with routes that are unreachable under "cheapest route that is good enough" while their prose insists they are the right choice.

```json
{
  "delegate": {
    "modelCatalog": {
      "luna-medium": {
        "provider": "openai-codex",
        "model": "gpt-5.6-luna",
        "thinking": "medium",
        "relativeCost": 2,
        "useFor": "Verify one named invariant over at most three named files; implement a localised change against a failing test, with the check command given.",
        "avoid": "Open-ended review with no criteria; deciding what to look for; work spanning subsystems."
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

There is no live channel, and this is why: while a foreground child runs, the parent is suspended inside its own tool call, so the parent's model cannot answer anything until that call returns. The only party who could answer mid-run is the user, which is a different feature and a less autonomous one. Ending the run *is* the question, and the continuation *is* the answer.

`Blocked:` is extracted into the handoff envelope rather than left in the body, so it sits next to the continuation token and survives truncation — a question that reaches the parent without its answer route is no use. Everything a default and a stated assumption can cover stays a default and a stated assumption.

## What the parent sees

Every run contributes an envelope — process status, outcome, conclusion, continuation, blocker, artifact, worktree metadata, evidence, risks, and truncation — before any report body is allocated. The original child report is then appended as the body and straightforwardly byte-truncated if necessary. Small duplication between the envelope and body is intentional: it keeps the handoff simple and preserves the original report when it fits.

The safety bounds are 12 KiB for one result, 8 KiB per task in parallel, and 50 KiB for a parallel aggregate. They bound parent context; they do not promise savings. If mandatory envelopes alone exceed a bound, bodies are omitted rather than dropping conclusions, continuations, or other metadata.

An exact-output artifact is created only when the parent handoff genuinely omits or truncates that original report. A report that fits does not get an artifact merely because its fields also appear in the envelope.

## Read-only delegates

A read-only delegate gets `read`, `bash`, `grep`, `find`, and `ls`, and is told in its prompt to inspect and report rather than edit. This is an intent signal, not an enforced boundary: the child has an ordinary shell and can do everything any agent with a shell can do. Use it when you want an answer, not a change.

## Writable delegates

`allowWrites: true` gives the task `edit` and `write` alongside the shell, and runs it in its own git worktree on a fresh `pi/<task-name>` branch under `.worktrees/`. Parallel writable tasks therefore never collide, even on the same files — that, not security, is what the worktree is for.

Setup needs no per-repository hooks:

- each package directory's `node_modules` is symlinked from the parent checkout, so nothing is reinstalled;
- gitignored essentials (`.env` and friends) are copied in;
- `.worktrees/` is added to `.git/info/exclude`, never to the tracked `.gitignore`;
- checkout hooks are disabled for the worktree git creates on your behalf.

By default (`from: 'wip'`) the parent's uncommitted work — the tracked diff plus untracked, non-ignored files — is reproduced inside the worktree, so the child sees the repository as you see it. `from: 'head'` starts from the last commit instead.

The carry lands as its own commit rather than as pending changes. That buys two things: the child starts on a clean tree, so its own commits describe only its own work, and the parent can be shown `carryCommit..branch` on review instead of a diff with its own uncommitted changes mixed into what it is judging. `changedPaths` counts only what the child changed, for the same reason.

The child is asked to commit as it goes and told explicitly not to merge, rebase, push, or switch branches. Anything it leaves uncommitted is committed for it when the run ends, so the branch is always the complete deliverable. Injected files (the `node_modules` symlink, carried `.env`) are never committed.

A continuation reuses its original worktree, working directory, route, and scope, and must repeat `allowWrites: true`. If a worktree cannot be created — no repository, or git refuses — the task still runs writably in the parent checkout and says why.

`scope` is advisory in both directions now. It tells the child where the work is expected to land; nothing enforces it.

## Integrating the result

A finished writable run reports its branch, its base commit, and the paths it changed. Nothing bespoke carries the work back: it is a git branch, and the orchestrating agent is expected to integrate it itself. The `delegate_branches` tool is the fan-in counterpart to parallel worktrees — it accepts a worktree id or a continuation token:

```text
delegate_branches list                    # every branch, and whether it is merged yet
delegate_branches review <id>             # the child's commits, stat, and diff
delegate_branches merge <id>              # integrate into your checkout
delegate_branches drop <id>               # delete the checkout and the branch
```

`review` measures from the child's own starting point, so carried parent work never appears as the child's. `merge` integrates only the child's commits after `workBase`, not the carry snapshot. For `from: 'wip'`, it therefore preserves non-overlapping dirty parent state while refusing to proceed when a child-edited path is also dirty in the parent. It either lands or leaves the checkout exactly as it was: a conflict is aborted rather than parked, because an agent working on from a half-merged tree makes a worse mess than one told to resolve deliberately. `drop` refuses unmerged work without `force`.

`/delegate-worktrees` inspects and cleans up from the parent session:

```text
/delegate-worktrees                              # list
/delegate-worktrees <id-or-continuation>         # show branch, base, changed paths
/delegate-worktrees <id-or-continuation> remove  # drop the checkout, keep the branch
/delegate-worktrees <id-or-continuation> drop    # drop the checkout and the branch
```
