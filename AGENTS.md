This repo contains local Pi agent configuration, themes, and extensions.

Most code changes should be under `extensions/` unless the task says otherwise.

This is a Bun workspace; use `bun` for workspace tasks (installing, adding
dependencies, and running package scripts). Run `bun run hooks:install` once
after cloning; the versioned checkout hook installs worktree-local dependencies.

Run checks scoped to the code you changed. Prefer focused validation during
implementation and before finishing a local change; do not default to the full
repository check when a narrower command proves the same thing.

- `bun run typecheck:extensions` — extensions and their imported dependencies
- `bun run typecheck:packages` — every package under `packages/*`
- `bun run typecheck:apps` — every app under `apps/*`
- `bun run typecheck` — all three typecheck scopes; `workspace:typecheck`
  remains a compatibility alias for packages plus apps
- `bun x vitest run <path>` — focused root/extension tests
- `bun run --filter <workspace> test` — one package or app test suite
- `bun x biome check <path...>` — focused lint and formatting validation
- `bun run lint` and `bun run format` — repository-wide Biome checks
- `bun run check` — full validation, reserved for cross-cutting changes,
  validation infrastructure, release/deployment work, or an explicit request

Use fix scripts when appropriate:

- `bun run lint:fix`
- `bun run format:fix`

Use Conventional Commits for every commit message (for example, `fix(delegate): deduplicate queued completions` or `docs(feedback): record ticket decision`).

Delegate any useful, independently describable chunk when briefing, verification, and integration cost less than doing it directly. For consequential multi-file implementation with explicit acceptance criteria, prefer a writable delegate once the design is settled. Keep direct parent edits for trivial or local changes, urgent feedback loops, branch integration, and fixes discovered during final verification.

For shared-checkout and commit hygiene, follow `docs/development-workflow.md`.

For changes that affect the dashboard, read and follow `docs/dashboard-deployment.md` before finishing, including its browser-test guidance and production deployment checks.
