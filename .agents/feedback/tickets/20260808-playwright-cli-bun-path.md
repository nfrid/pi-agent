# HFM-20260808: Resolve Bun-installed Playwright CLI from the browser skill

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-08-08
- **Source reports:** [Pi session PATH omits the Bun-installed Playwright CLI](../inbox/20260808T220458Z-playwright-skill-cli-unavailable.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

The global browser-automation skill assumes `playwright-cli` is available through normal command lookup. Pi sessions can omit Bun's global binary directory from `PATH` even when the CLI is already installed there, causing a false missing-installation diagnosis and unnecessary project-specific fallback work.

## Baseline

In the observed Pi session:

- `command -v playwright-cli` returned no result.
- `PATH` did not include `/Users/nfrid/.bun/bin`.
- `$HOME/.bun/bin/playwright-cli` existed and linked to Bun's global `@playwright/cli` installation.
- `$HOME/.bun/bin/playwright-cli --help` succeeded.
- Production browser verification required a hand-written script using a workspace-local `@playwright/test` dependency before the existing global CLI was found.

No existing inbox report or proposed ticket describes this Playwright/Bun PATH mismatch.

## Hypothesis

If the browser skill checks the standard Bun global binary location when `playwright-cli` is absent from `PATH`, then Pi can use the already-installed CLI without installation advice or repository-specific fallback code, because the executable itself is healthy and only command discovery is failing.

## Guardrails

- Do not install or upgrade packages automatically.
- Do not mutate the Pi process's global `PATH` from the skill.
- Preserve normal `PATH` precedence when `playwright-cli` is already discoverable.
- Do not assume Bun is installed or that its global directory exists.
- Keep project-local Playwright fallback guidance for environments where neither executable is available.

## Options considered

1. **Add a Bun-aware resolver to the skill:** Check `command -v playwright-cli`, then executable paths under `${BUN_INSTALL:-$HOME/.bun}/bin`, before suggesting local fallback or installation. This is narrow, observable, and does not alter process-wide environment.
2. **Add `~/.bun/bin` to every Pi session's PATH:** Makes all Bun global commands discoverable, but broadens the change beyond browser automation and may alter command precedence for unrelated tools.
3. **Leave the skill unchanged and rely on project dependencies:** Requires repeated repository-specific discovery and fails in projects without Playwright installed.

## Recommendation

Add the Bun-aware executable resolution step to the global `playwright-cli` skill. Prefer the PATH-resolved command, fall back to `${BUN_INSTALL:-$HOME/.bun}/bin/playwright-cli` when executable, and only then use the existing local-installation guidance. This addresses the verified failure without changing the environment for unrelated commands.

## Scope

- **In:** Browser-skill command discovery, Bun's standard/configured global binary location, and concise fallback instructions.
- **Out:** Package installation, package upgrades, global PATH policy, browser API changes, and project-owned Playwright configuration.

## Acceptance criteria

- [ ] With `playwright-cli` on `PATH`, the skill continues to use that executable.
- [ ] With `playwright-cli` absent from `PATH` and executable at `${BUN_INSTALL:-$HOME/.bun}/bin/playwright-cli`, the skill uses the installed CLI successfully.
- [ ] With neither executable available, the skill retains actionable local fallback and installation guidance.
- [ ] Resolution does not install packages or mutate process-wide `PATH`.

## Validation

1. Run the documented resolver with a PATH-resolved test executable and confirm it is selected first.
2. Run with a controlled `PATH` that excludes Bun while a fixture executable exists under a temporary `BUN_INSTALL`; confirm the Bun executable is selected and invoked.
3. Run with neither location available; confirm the guidance reaches the local fallback rather than claiming success.
4. Run `npm run check` after an approved implementation.
5. Compare the first five browser-automation tasks after merge against the baseline for false missing-installation diagnoses or project-specific fallback scripts.

## Evaluation

- **Window:** First five browser-automation tasks after an approved merge, or 14 days, whichever comes first (not started)
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
