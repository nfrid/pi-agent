# HF-20260806: Command output can expose secret-bearing process environments

- **Status:** new
- **Observed date:** 2026-08-06
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Diagnose a macOS networking regression using bounded process and unified-log inspection.
- **Harness component:** Bash tool output handling
- **Route / attempt / outcome:** A targeted `log show` diagnostic succeeded, but its returned output included an application's full inherited environment with credential values.
- **Observed cost / rework:** Secret values entered the model-visible tool transcript and could have been repeated in later summaries or responses.
- **Recurrence / confidence:** Likely recurring whenever macOS unified logs, process dumps, crash reports, or debug endpoints include environments; high confidence.
- **Ticket:** —

## Behavior

Bash tool output is returned verbatim even when a diagnostic command unexpectedly includes environment variables whose names clearly indicate credentials or tokens.

## Impact

Routine process and log diagnostics can expose unrelated secrets to the agent context. The caller often cannot predict that a system log entry will serialize an entire inherited environment, so command-side filtering alone is unreliable.

## Evidence

A bounded macOS `log show` query for OrbStack startup events returned a RunningBoard job description containing multiple environment entries with names such as `*_TOKEN` and `*_API_TOKEN`, including their values. The command did not intentionally request or print credential files.

## Smallest improvement

Redact values in tool output for environment-style keys matching common secret markers (`TOKEN`, `PASSWORD`, `SECRET`, `API_KEY`, credential variants) before the output is stored or displayed, while preserving the key name and a redaction marker.
