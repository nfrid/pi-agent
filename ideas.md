# Ideas to try

## new features

- "computer use" or some sort of it

## maintenance

- cover `extensions/artifacts` with tests (80 source lines, currently the only
  extension with no test file; `extensions/shared/artifacts` is covered)
- decompose `extensions/delegate` (~8k source lines / 47 files) — manual, by hand
- prune old `sessions/` and `.delegate-sessions/` entries once they get
  unreasonably large (kept for analysis; 202M / 76M as of 2026-07-30)
