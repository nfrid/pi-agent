# HF-20260808: Pi session PATH omits the Bun-installed Playwright CLI

- **Status:** triaged
- **Observed date:** 2026-08-08
- **Source cwd/repo:** `/Users/nfrid/.pi/agent` (local Pi agent configuration repository)
- **Task shape:** Implement, deploy, and production-smoke-test a dashboard UI change.
- **Harness component:** Pi process environment and global `playwright-cli` skill
- **Route / attempt / outcome:** The skill was selected for browser verification, but `playwright-cli` was not discoverable because the Pi session's `PATH` omitted `~/.bun/bin`. The installed executable worked by absolute path; the task had already fallen back to the dashboard workspace's local `@playwright/test` installation.
- **Observed cost / rework:** Required multiple environment-specific attempts and a hand-written local Playwright script before the existing CLI installation was located.
- **Recurrence / confidence:** Likely in Pi sessions launched with the same PATH while global tools are installed through Bun; high confidence from direct executable and environment inspection.
- **Ticket:** [HFM-20260808: Resolve Bun-installed Playwright CLI from the browser skill](../tickets/20260808-playwright-cli-bun-path.md)

## Behavior

The global browser-automation skill documents `playwright-cli` as its primary interface. The CLI was installed at `~/.bun/bin/playwright-cli`, but the Pi process environment did not include `~/.bun/bin` in `PATH`, so normal command lookup reported it as unavailable.

## Impact

Invoking the skill cannot reach an already-installed browser capability through normal command lookup. This causes false missing-installation diagnoses and unnecessary project-specific fallback code.

## Evidence

- `command -v playwright-cli` returned no result in the Pi session.
- The observed `PATH` did not contain `/Users/nfrid/.bun/bin`.
- `/Users/nfrid/.bun/bin/playwright-cli` exists and links to the Bun global installation of `@playwright/cli`.
- Running `/Users/nfrid/.bun/bin/playwright-cli --help` succeeded and reported the installed CLI version.
- The browser smoke test had succeeded through `apps/dashboard-web`'s local `@playwright/test` dependency rather than the existing global CLI.

## Smallest improvement

Include the Bun global binary directory in Pi's inherited `PATH`, or have the skill resolve the known Bun install location before concluding that `playwright-cli` is unavailable.
