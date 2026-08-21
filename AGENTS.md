This repo contains local Pi agent configuration, themes, and extensions.

Most code changes should be under `extensions/` unless the task says otherwise.

## Simplicity and scope

- Prefer the smallest complete change. Do not add abstractions, configuration,
  compatibility layers, or extension points without a current concrete need.
- Apply YAGNI aggressively. Do not build for hypothetical callers, future
  features, or unsupported states.
- Use DRY to prevent behavior from drifting, not to eliminate every repeated
  line. Keep small explicit code when an abstraction would add indirection,
  weaken types, or serve only one or two callers.
- Before adding a helper, identify its production callers. Delete helpers,
  exports, state, and tests that have no production consumer.
- Reuse one authoritative implementation for parsing, validation, ordering, and
  state transitions. Do not maintain parallel definitions of the same rule.
- Keep feature logic in one layer when possible. Avoid deriving state,
  flattening it, and deriving the same state again downstream.
- Test user-visible behavior and important boundaries. Do not repeat the same
  assertion across unit, component, and browser tests unless each layer covers
  a distinct failure mode.
- Prefer semantic assertions over exact DOM structure, pixel values, call order,
  or internal helper output.
- Treat scope spillover as a defect. A local feature must not change unrelated
  ordering, defaults, routes, or screens without an explicit requirement.
- Preserve compatibility only for a named supported consumer or a documented
  persisted contract. Do not add shims for hypothetical clients.
- When two implementations are equally correct, choose the one with fewer
  concepts, states, files, and maintenance obligations, not merely fewer lines.
- After implementation, run a deletion pass. Remove superseded code, stale
  documentation, redundant tests, speculative compatibility handling, and
  abstractions that did not earn their cost.

This is a pnpm workspace; use `pnpm` for workspace tasks (installing, adding
dependencies, running package scripts). Root scripts also work through
`npm run <script>` — they delegate to pnpm internally.

Run checks scoped to the code you changed. Prefer focused validation during
implementation and before finishing a local change; do not default to the full
repository check when a narrower command proves the same thing.

- `pnpm run typecheck:extensions` — extensions and their imported dependencies
- `pnpm run typecheck:packages` — every package under `packages/*`
- `pnpm run typecheck:apps` — every app under `apps/*`
- `pnpm run typecheck` — all three typecheck scopes; `workspace:typecheck`
  remains a compatibility alias for packages plus apps
- `pnpm exec vitest run <path>` — focused root/extension tests
- `pnpm --filter <workspace> test` — one package or app test suite
- `pnpm exec biome check <path...>` — focused lint and formatting validation
- `pnpm run lint` and `pnpm run format` — repository-wide Biome checks
- `pnpm run check` — full validation, reserved for cross-cutting changes,
  validation infrastructure, release/deployment work, or an explicit request

Use fix scripts when appropriate:

- `pnpm run lint:fix`
- `pnpm run format:fix`

Use Conventional Commits for every commit message (for example, `fix(delegate): deduplicate queued completions` or `docs(feedback): record ticket decision`).

Delegate any useful, independently describable chunk when briefing, verification, and integration cost less than doing it directly. For consequential multi-file implementation with explicit acceptance criteria, prefer a writable delegate once the design is settled. Keep direct parent edits for trivial or local changes, urgent feedback loops, branch integration, and fixes discovered during final verification.

For shared-checkout and commit hygiene, follow `docs/development-workflow.md`.

For changes that affect the dashboard, read and follow `docs/dashboard-deployment.md` before finishing, including its browser-test guidance and production deployment checks.
