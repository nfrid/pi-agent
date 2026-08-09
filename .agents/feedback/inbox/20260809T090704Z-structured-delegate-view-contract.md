# HF-20260809: Structured delegate view syntax is not discoverable from the tool contract

- **Status:** new
- **Observed date:** 2026-08-09
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Launch a bounded implementation delegate with a JSON result projection and a named review view.
- **Harness component:** `delegate.result.projection` and `delegate.result.views`
- **Route / attempt / outcome:** Two `luna-xhigh` delegate setup attempts were rejected while constructing the structured result contract; the task proceeded only after dropping structured output and using legacy prose.
- **Observed cost / rework:** Two validation retries and loss of bounded machine-readable output; the eventual prose result was truncated.
- **Recurrence / confidence:** Observed in this session with high confidence; likely for first-time callers because the accepted `views` value syntax is absent from the exposed schema description.
- **Ticket:** —

## Behavior

The result contract states that projection entries are paths and that `views` supports named static views, but does not show the accepted syntax for either. Projection values without a leading slash failed with an actionable path error. After correcting them to JSON pointers, a human-readable view template string was itself interpreted as a path and rejected. No example or field schema explained what a valid named view value should contain.

## Impact

Agents can spend multiple setup attempts reverse-engineering a validation-only API. Abandoning structured output then increases parent-context use and exposes the workflow to prose truncation, defeating the bounded-result capability.

## Evidence

- First setup rejection: result paths had to start with `/`.
- Second setup rejection treated the complete named-view template text as an invalid result path.
- The exposed tool description describes `views` only as an object with string values and does not provide an accepted example.
- Removing `result` entirely allowed the delegate to run, but its returned report was truncated.

## Smallest improvement

Add one valid end-to-end `result` example to the `delegate` tool contract showing the schema, JSON-pointer projections, named view declaration, and matching `handoffFrom.view`. Make validation errors identify the exact field (`projection` versus a named `views` entry) and state the expected syntax.
