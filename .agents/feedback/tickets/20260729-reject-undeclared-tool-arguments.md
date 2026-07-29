# HFM-20260729: Reject undeclared tool arguments

- **Status:** proposed
- **Approval:** not approved
- **Decision:** deferred on 2026-07-29 — owned by the host harness/tool router
- **Created:** 2026-07-29
- **Source reports:** [HF-20260729: Bash silently ignores an unsupported workdir parameter](../inbox/20260729T103914Z-bash-ignores-workdir.md)

## Problem

A `functions.bash` call can accept an undeclared argument, discard it, and execute with the remaining arguments. When the discarded argument controls where or how a command is intended to run, the command may operate on the wrong repository without an immediate validation error.

## Baseline

One observed call supplied `workdir: /Users/nfrid/job/kibana-logs` even though `functions.bash` does not declare `workdir`. The tool ran from the session cwd, `/Users/nfrid/job`, and failed with `Script not found "check"`; using an explicit `cd kibana-logs && ...` then ran the intended package check. This verifies silent argument loss for that call. The recurrence rate and whether the behavior affects every tool schema remain unmeasured.

## Hypothesis

If tool-call validation rejects undeclared object properties before execution, then calls containing unsupported cwd-like parameters will fail explicitly without running their command, because the mismatch will be caught at the tool boundary rather than silently normalized.

## Guardrails

- Do not add `workdir` as an alias with ambiguous precedence; adding a supported `cwd` parameter is a separate option.
- Do not change validation of declared optional properties or valid existing calls.
- Return a concise error that identifies the tool and undeclared property.
- Apply strictness consistently at the shared tool-call boundary where possible; avoid one-off Bash-only parsing unless the boundary cannot enforce it safely.

## Options considered

1. **Reject unknown properties at the shared tool-call boundary:** Prevents silent loss for all tools and gives one consistent rule, but may reveal callers that currently rely on permissive schemas.
2. **Add `cwd` to Bash:** Makes the intended operation expressible and aligns with background execution, but does not address silent unknown arguments generally and expands the Bash API.
3. **Reject only `workdir` in Bash:** Smallest local patch, but leaves equivalent typos and unsupported properties undetected.

## Recommendation

Defer implementation in this checkout. The built-in Bash schema and pre-dispatch argument validation are supplied by the installed Pi packages, while this repository only consumes those packages. Route the change to the host harness / `pi-ai` validation owner: enforce rejection of undeclared tool-call properties at that shared boundary, while preserving schemas that explicitly allow additional properties. Consider a separate `cwd` addition only if user demand remains after strict errors make the mismatch visible.

## Scope

- **In:** Upstream validation of unknown top-level properties in tool arguments; an actionable error before tool execution; compatibility coverage for valid calls.
- **Out:** Editing installed dependencies in this checkout, adding Bash cwd support, accepting aliases, changing command execution semantics, or validating arbitrary nested command content.

## Acceptance criteria

- [ ] A `functions.bash` call containing undeclared `workdir` is rejected before the command starts.
- [ ] The error names `workdir` as unsupported (and identifies Bash directly or through the failed tool call).
- [ ] Existing calls containing only declared arguments continue to execute unchanged.
- [ ] A representative non-Bash tool also rejects an undeclared top-level property, or the ticket records why enforcement must remain Bash-specific.

## Validation

- Add a tool-boundary test with a side-effecting Bash stub and assert the stub is not invoked when `workdir` is supplied.
- Add or retain positive tests for valid Bash arguments and at least one other registered tool.
- Run `npm run check`.
- During the evaluation window, inspect harness validation errors for unknown-property failures and any valid-call regressions; compare with the baseline of one silent wrong-directory execution.

## Evaluation

- **Window:** First 14 days or 30 tool validation failures after merge, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
