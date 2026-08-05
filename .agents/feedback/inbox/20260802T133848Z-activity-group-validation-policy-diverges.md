# HF-20260802: Activity grouping and outcome metrics disagree on validation commands

- **Status:** duplicate
- **Observed date:** 2026-08-02
- **Source cwd/repo:** `/Users/nfrid/.pi/agent` (local Pi agent configuration)
- **Task shape:** Maintainer audit of extensions for over-engineering and refactoring opportunities
- **Harness component:** Activity-group classification and session outcome metrics
- **Route / attempt / outcome:** Static audit on the parent route plus a `sol-medium` maintainer-review delegate; both identified duplicated validation policy
- **Observed cost / rework:** A local deduplication would be premature because validation affects both transcript grouping and offline outcome interpretation
- **Recurrence / confidence:** Deterministic for matching commands; high confidence
- **Ticket:** [HFM-20260730: Derive task outcome episodes automatically](../tickets/20260730-derive-task-outcome-episodes.md)

## Behavior

Activity grouping and outcome metrics independently classify shell validation commands with different rules. Grouping treats every `npm run`, `pnpm run`, `yarn run`, or `bun run` command as validation, while outcome metrics recognize named validation families such as check, lint, test, typecheck, and format.

## Impact

The same tool call can be presented as validation in the interactive transcript but omitted from validation outcome metrics. This makes group boundaries and retrospective measurements disagree, and changing only one classifier risks silently redefining activity phases without revisiting the intended grouping model.

## Evidence

- `extensions/activity-groups/grouping.ts:61-62,138-150` uses `VALIDATION_COMMAND`, whose package-run branch matches every package script.
- `extensions/activity-groups/outcome-core.mjs:198-213` uses `validationKindsOf`, which recognizes only named validation families.
- For example, `npm run build` matches the grouping regex but produces no validation kind in `validationKindsOf`.
- Existing tests cover `npm run lint`, but no parity test establishes a shared policy for non-validation package scripts.

## Smallest improvement

Define and test one explicit harness-level contract for what counts as validation before changing either classifier. The contract should make interactive grouping and offline outcomes agree on representative validation, build, generation, and arbitrary package-script commands; implementation can then share policy without treating deduplication alone as the design decision.
