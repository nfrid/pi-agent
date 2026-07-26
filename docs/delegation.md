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

The child is asked to commit as it goes and told explicitly not to merge, rebase, push, or switch branches. Anything it leaves uncommitted is committed for it when the run ends, so the branch is always the complete deliverable. Injected files (the `node_modules` symlink, carried `.env`) are never committed.

A continuation reuses its original worktree, working directory, route, and scope, and must repeat `allowWrites: true`. If a worktree cannot be created — no repository, or git refuses — the task still runs writably in the parent checkout and says why.

`scope` is advisory in both directions now. It tells the child where the work is expected to land; nothing enforces it.

## Integrating the result

A finished writable run reports its branch, its base commit, and the paths it changed. The orchestrating agent integrates it with ordinary git rather than a bespoke protocol, and is expected to do so itself:

```text
git diff <base>..<branch>      # review
git merge <branch>             # integrate
```

Worktrees can be inspected and cleaned up from the parent session:

```text
/delegate-worktrees                              # list
/delegate-worktrees <id-or-continuation>         # show branch, base, changed paths
/delegate-worktrees <id-or-continuation> remove  # drop the checkout, keep the branch
/delegate-worktrees <id-or-continuation> drop    # drop the checkout and the branch
```
