This repo contains local Pi agent configuration, themes, and extensions.

Most code changes should be under `extensions/` unless the task says otherwise.

This is a pnpm workspace; use `pnpm` for workspace tasks (installing, adding
dependencies, running package scripts). Root scripts also work through
`npm run <script>` — they delegate to pnpm internally.

Run the relevant checks before finishing code changes:

- `pnpm run check` — full validation: Node/SDK version guards, root and
  workspace typecheck, Biome lint and format, root (extensions) tests, and
  workspace package tests (most times just run this)
- `pnpm run typecheck` — root tsconfig only (extensions, most `packages/*`,
  dashboard-server); `pnpm run workspace:typecheck` covers every workspace
  package including `@pi-dashboard/web`
- `pnpm run lint` — Biome lint/check
- `pnpm run format` — Biome formatting check

Use fix scripts when appropriate:

- `pnpm run lint:fix`
- `pnpm run format:fix`

Use Conventional Commits for every commit message (for example, `fix(delegate): deduplicate queued completions` or `docs(feedback): record ticket decision`).

For consequential multi-file implementation with explicit acceptance criteria, prefer a writable delegate once the design is settled. Keep direct parent edits for trivial or local changes, urgent feedback loops, branch integration, and fixes discovered during final verification.

For shared-checkout and commit hygiene, follow `docs/development-workflow.md`.

For changes that affect the dashboard, read and follow `docs/dashboard-deployment.md` before finishing, including its browser-test guidance and production deployment checks.
