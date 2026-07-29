# HFM-20260729: Reject undeclared tool arguments

- **Status:** evaluation-pending
- **Approval:** approved 2026-07-29
- **Decision:** enforce strict top-level validation locally with a pre-execution extension gate
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

Implement a local `tool_call` extension gate that looks up each built-in or custom tool through `pi.getAllTools()`, compiles its root schema as closed unless the schema explicitly defines additional-property behavior, and blocks unsupported arguments before execution. This avoids an upstream fork while applying one rule to every dynamically registered tool. Return an actionable block reason so the agent can correct the call. Bash `cwd` support is tracked separately in [HFM-20260729: Add explicit Bash cwd support](20260729-add-bash-cwd-support.md).

## Scope

- **In:** Local pre-execution validation of unknown top-level properties in every registered tool's arguments; an actionable block reason; explicit additional-property schemas; dynamic-tool and valid-call coverage.
- **Out:** Upstream Pi changes, editing installed dependencies, recursive nested-object strictness, adding Bash cwd support, accepting aliases, or changing command execution semantics.

## Acceptance criteria

- [x] A `functions.bash` call containing undeclared `workdir` is rejected before the command starts.
- [x] The error names `workdir` as unsupported (and identifies Bash directly or through the failed tool call).
- [x] Existing calls containing only declared arguments continue to execute unchanged.
- [x] A dynamically registered non-Bash tool also rejects an undeclared top-level property.

## Validation

- Cover TypeBox and plain schemas, records, unions/intersections, explicitly permissive and typed additional properties, and unchanged nested-object behavior.
- Register the extension against a mock runtime with a side-effecting dispatcher and assert blocked calls do not execute, valid calls do, and dynamically added custom tools are covered.
- Run `npm exec vitest run extensions/tool-argument-validation/index.test.ts` and `npm run check`.
- During the evaluation window, inspect blocked unknown-property calls and any valid-call regressions; compare with the baseline of one silent wrong-directory execution.

## Evaluation

- **Window:** Started 2026-07-29; ends after 30 blocked unknown-property calls, or 2026-08-12, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** Enforce strict top-level argument validation for all tools with a local pre-execution extension gate, preserving explicit additional-property schemas and returning an actionable block reason; approved 2026-07-29.
- **Merged change:** `405f2e3`
- **Resolution:** pending evaluation
