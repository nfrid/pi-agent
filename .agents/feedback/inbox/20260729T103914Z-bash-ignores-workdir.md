# HF-20260729: Bash silently ignores an unsupported workdir parameter

- **Status:** triaged
- **Observed date:** 2026-07-29
- **Source cwd/repo:** `/Users/nfrid/job` meta-repository
- **Task shape:** Multi-package TypeScript implementation and validation
- **Harness component:** `functions.bash` tool argument validation
- **Route / attempt / outcome:** A Bash call included `workdir: /Users/nfrid/job/kibana-logs`; the tool accepted the call but executed from `/Users/nfrid/job`.
- **Observed cost / rework:** The package install/check ran against the wrong directory, failed with `Script not found "check"`, and had to be repeated with an explicit `cd`.
- **Recurrence / confidence:** Observed once directly; high confidence and likely recurrent when tool interfaces differ on cwd support.
- **Tickets:** [HFM-20260729: Reject undeclared tool arguments](../tickets/20260729-reject-undeclared-tool-arguments.md); [HFM-20260729: Add explicit Bash cwd support](../tickets/20260729-add-bash-cwd-support.md)

## Behavior

`functions.bash` silently accepted an undeclared `workdir` property rather than rejecting it or honoring it. The command then ran in the session cwd.

## Impact

Silent argument loss can run validation or mutation commands in the wrong repository. The visible failure was harmless here, but commands with matching names in both directories could succeed against the wrong target.

## Evidence

The call intended for `kibana-logs` returned `Script not found "check"`. Repeating the same operation as `cd kibana-logs && ...` installed dependencies and ran the package check successfully.

## Smallest improvement

Reject undeclared tool arguments with a validation error. Alternatively, add an explicit `cwd` parameter to `functions.bash`; silent ignoring should not occur.
