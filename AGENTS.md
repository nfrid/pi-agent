This repo contains local Pi agent configuration, themes, and extensions.

Most code changes should be under `extensions/` unless the task says otherwise.

Run the relevant checks before finishing code changes:

- `npm run typecheck` — TypeScript validation
- `npm run lint` — Biome lint/check for `extensions/`
- `npm run format` — Biome formatting check
- `npm run check` — full validation (most times just run this)

Use fix scripts when appropriate:

- `npm run lint:fix`
- `npm run format:fix`
