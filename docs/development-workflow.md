# Development workflow

This repository may be used by more than one agent or terminal at the same time. Treat the checkout as shared state: preserve work you did not create, and make every commit describe only the task you own.

When another writable agent or terminal is known to be working in this checkout, do not begin new writes in the shared checkout. Use a separate Git worktree. If concurrent changes become apparent after work starts, preserve them and move remaining implementation and isolated validation to a worktree when practical.

## Establish a baseline

Before editing, record the current repository state:

```sh
git status --short --untracked-files=all
git rev-parse --short HEAD
```

Recheck both before formatting, staging, committing, and deploying. A newly modified file, a new hunk in a file you are editing, or an advanced `HEAD` may belong to another task.

## Concurrent changes

When unrelated changes appear during a task:

- Do not revert, overwrite, stage, commit, or deploy them.
- Do not stop an unfamiliar server or test process merely because it owns a port; identify the process and use an isolated port or workspace when possible.
- Avoid commands that rewrite unrelated paths. If your file also contains concurrent hunks, review and stage only the hunks you own.
- Validation in the shared checkout proves the combined tree. When exact isolation matters, validate the intended commit in a detached worktree.
- If `HEAD` advances, verify that your commit is still an ancestor of the new `HEAD` before continuing.

Do not use destructive cleanup (`git reset --hard`, broad checkout/restore commands, or deleting untracked files) to obtain a clean tree.

## Validate the smallest relevant scope

Start with checks that match the files and subsystem you changed. This shortens
the feedback loop and avoids repeatedly typechecking and testing unrelated apps
or packages.

```sh
# TypeScript scopes
bun run typecheck:extensions
bun run typecheck:packages
bun run typecheck:apps

# One root or extension test file
bun x vitest run extensions/example/example.test.ts

# One workspace and focused Biome paths
bun run --filter <workspace-name> test
bun x biome check path/to/changed-file.ts
```

Combine scopes only when the change crosses them. `bun run typecheck` runs all
three TypeScript categories. Use `bun run check` for changes to shared validation
configuration, cross-cutting interfaces, release or deployment work, or when a
full repository result is explicitly required. A narrow change does not need a
full check when its scoped typecheck, tests, and Biome check cover the affected
behavior.

## Staging and committing

Inspect the staged result rather than relying on the working-tree diff:

```sh
git diff --cached --check
git diff --cached --stat
git diff --cached --name-only
```

For files containing mixed ownership, use patch staging and then inspect `git diff --cached`. Commit only after the staged patch contains the complete intended change and no unrelated hunks.

After committing:

- Confirm the commit appears in `git log`.
- Report any remaining uncommitted changes and whether they belong to another task.
- If another task advanced `HEAD`, confirm your commit remains in history with `git merge-base --is-ancestor <commit> HEAD`.
