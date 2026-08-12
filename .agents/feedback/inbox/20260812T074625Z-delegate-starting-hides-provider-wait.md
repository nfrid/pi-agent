# HF-20260812: Delegate starting state does not distinguish provider wait from harness setup

- **Status:** new
- **Observed date:** 2026-08-12
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Launch a small read-only diagnostic delegate and determine whether a recent dashboard fix caused a long startup.
- **Harness component:** Delegate activity/status reporting
- **Route / attempt / outcome:** `luna-low` read-only diagnostic delegate succeeded; first child model output arrived roughly 50 seconds after launch.
- **Observed cost / rework:** The long undifferentiated starting phase was attributed to a code/cache regression until timestamps were inspected manually.
- **Recurrence / confidence:** One directly measured run; moderate confidence that slow first-token periods recur under provider load.
- **Ticket:** —

## Behavior

Before the first child model event, the delegate UI reports only a generic starting/running state. It does not distinguish completed harness setup and child launch from waiting for the provider's first response.

## Impact

A slow provider response looks like worktree setup, extension loading, queueing, or a broken dashboard update. Users cannot tell whether intervention is useful or which subsystem is delayed.

## Evidence

- The child session was created and its user prompt persisted before the first assistant event.
- The first assistant thinking event arrived about 50 seconds after delegate launch in the observed successful `luna-low` run.
- Once the first event arrived, thinking and tool activity streamed normally and the delegate completed successfully.
- No evidence tied that wait to the dashboard transcript changes; provider wait is the supported interpretation from event timing.

## Smallest improvement

Expose a distinct bounded phase such as `launching child` followed by `waiting for first model response`, using existing child-launch and first-event timestamps, so startup delay can be attributed without inspecting session files.
