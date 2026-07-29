# HFM-20260729: Add explicit Bash cwd support

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-07-29
- **Source reports:** [HF-20260729: Bash silently ignores an unsupported workdir parameter](../inbox/20260729T103914Z-bash-ignores-workdir.md)

## Problem

`functions.bash` can execute only from the session working directory. An agent operating in a nested package must embed `cd <path> && ...` in shell text, even though other execution tools expose an explicit working-directory argument. This is less structured, harder to render accurately, and easy to get wrong when moving between repositories.

## Baseline

The observed task needed to run a package check under `/Users/nfrid/job/kibana-logs`. Bash did not declare a cwd argument, and an attempted `workdir` property was silently ignored. An explicit `cd kibana-logs && ...` succeeded. Strict unknown-argument validation is tracked separately and now makes the unsupported property fail safely, but it does not provide structured cwd selection. The installed built-in Bash accepts `command` and `timeout` and receives a fixed cwd when its tool definition is created.

## Hypothesis

If Bash declares an optional `cwd` argument and resolves it before execution, then agents can target a package without shell-level directory changes, because the execution directory becomes validated tool data rather than command text.

## Guardrails

- Keep the current session cwd as the default when `cwd` is omitted.
- Use the name `cwd`; do not add a `workdir` alias.
- Reject a missing or non-directory target before command execution with a recoverable tool error.
- Preserve command, timeout, abort, output, and rendering behavior.
- Do not treat cwd selection as a security boundary; Bash already permits `cd` and arbitrary shell commands.
- Do not combine this feature with strict unknown-argument validation or dependency installation.

## Options considered

1. **Add optional `cwd` to Bash:** Structured, renderable, and consistent with execution APIs, but expands the public tool contract and needs path/error tests.
2. **Continue requiring `cd` in command text:** No API change, but retains quoting, composition, and wrong-directory risks.
3. **Add `workdir` or both names:** Matches the observed mistaken argument, but creates alias and precedence complexity without a clear benefit.

## Recommendation

After strict tool validation has been evaluated, register a local Bash override that adds one optional `cwd` property while delegating execution to Pi's exported Bash tool implementation. Resolve relative paths against the session cwd and instantiate/delegate to the Bash implementation with the selected directory. Preserve the built-in renderer and result shape rather than reimplementing command execution.

## Scope

- **In:** Optional Bash `cwd`; absolute and relative path resolution; pre-execution directory errors; rendering and focused tests.
- **Out:** A `workdir` alias, per-command cwd arrays, sandboxing, automatic repository discovery, or changes to non-Bash tools.

## Acceptance criteria

- [ ] Omitting `cwd` preserves current execution from the session cwd.
- [ ] An absolute `cwd` executes the command in that directory.
- [ ] A relative `cwd` resolves against the session cwd, not the process cwd.
- [ ] A missing or non-directory `cwd` returns a recoverable error before command execution.
- [ ] Tool rendering makes a non-default cwd visible.
- [ ] `workdir` remains unsupported and is rejected by strict validation.

## Validation

- Add local override tests for default, absolute, relative, missing, and non-directory cwd behavior.
- Assert the delegated Bash implementation receives the resolved cwd and is not invoked for invalid targets.
- Confirm inherited rendering and the built-in result shape remain intact.
- Run the focused extension tests and `npm run check`.
- During the evaluation window, compare wrong-directory retries with the baseline incident and inspect cwd-related validation failures.

## Evaluation

- **Window:** not started; proposed window is the first 30 Bash calls using `cwd`, or 14 days after merge, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
