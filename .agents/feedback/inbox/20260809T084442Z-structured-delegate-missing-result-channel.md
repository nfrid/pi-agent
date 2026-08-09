# HF-20260809: Structured delegate can finish without required result channel

- **Status:** new
- **Observed date:** 2026-08-09
- **Source cwd/repo:** `/Users/nfrid/.pi/agent` (Pi agent configuration repository)
- **Task shape:** Read-only repository mapping delegated with a bounded structured-result schema
- **Harness component:** `delegate` structured-result lifecycle
- **Route / attempt / outcome:** `luna-high`; child run ended with `child-result-invalid` because the `delegate_result` channel was missing
- **Observed cost / rework:** The delegated repository analysis was unavailable, so the parent repeated the exploration directly.
- **Recurrence / confidence:** Observed once in this session; high confidence in the failure mode, unknown recurrence rate
- **Ticket:** —

## Behavior

A delegate invoked with a valid structured `result` contract completed its run without emitting the required `delegate_result` channel. The harness rejected the entire result as invalid rather than recovering the otherwise completed attempt.

## Impact

A completed child attempt can produce no usable findings, forcing duplicate repository exploration and making structured delegation less reliable than unstructured delegation for bounded analysis tasks.

## Evidence

The delegate completion reported:

- status: `error`
- structured result: `invalid`
- validation error: `delegate_result channel is missing`
- lifecycle reason: `child-result-invalid`
- continuation usable: `yes`

The parent then performed the requested dashboard feature mapping directly. A later unstructured `luna-high` regression-review delegate completed successfully, so no route-description mismatch was observed.

## Smallest improvement

When a structured delegate finishes without the required result channel, give the child one automatic corrective turn that requests emission of the already-specified structured result before declaring the attempt invalid.
