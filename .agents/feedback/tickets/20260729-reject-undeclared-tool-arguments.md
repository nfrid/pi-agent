# HFM-20260729: Reject undeclared tool arguments

- **Status:** approved
- **Approval:** approved 2026-07-29
- **Decision:** implement strict top-level validation for all tools in the upstream Pi validation boundary
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

Implement the change in `/Users/nfrid/.pi/pi-mono`, which owns `packages/ai/src/utils/validation.ts` and the built-in tool schemas consumed by this checkout. Make top-level tool argument objects strict for all tools: reject properties not declared by the schema before execution, while preserving schemas that explicitly allow additional properties. Return the mismatch as a normal tool validation error so the agent can correct the call. Bash `cwd` support is tracked separately in [HFM-20260729: Add explicit Bash cwd support](20260729-add-bash-cwd-support.md).

## Scope

- **In:** Upstream validation of unknown top-level properties in every tool's arguments; an actionable pre-execution tool error; an explicit opt-in for schemas that allow additional properties; compatibility coverage for valid calls.
- **Out:** Editing installed dependencies in this checkout, adding Bash cwd support, accepting aliases, or changing command execution semantics.

## Acceptance criteria

- [ ] A `functions.bash` call containing undeclared `workdir` is rejected before the command starts.
- [ ] The error names `workdir` as unsupported (and identifies Bash directly or through the failed tool call).
- [ ] Existing calls containing only declared arguments continue to execute unchanged.
- [ ] A representative non-Bash tool also rejects an undeclared top-level property, or the ticket records why enforcement must remain Bash-specific.

## Validation

- Add upstream `packages/ai` validation tests for unknown properties, valid calls, and explicitly permissive schemas.
- Add a tool-loop test with a side-effecting stub and assert execution does not begin when an unknown property is supplied.
- Run the focused upstream tests and `/Users/nfrid/.pi/pi-mono/npm run check`.
- After an upstream release, update this checkout's pinned Pi packages and reproduce the original Bash call.
- During the evaluation window, inspect harness validation errors for unknown-property failures and any valid-call regressions; compare with the baseline of one silent wrong-directory execution.

## Evaluation

- **Window:** First 14 days or 30 tool validation failures after merge, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** Enforce strict top-level argument validation for all tools in upstream Pi, preserving explicit additional-property schemas and returning a recoverable pre-execution tool error; approved 2026-07-29.
- **Merged change:** —
- **Resolution:** pending evaluation
