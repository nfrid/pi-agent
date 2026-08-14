# HF-20260814: Delegate handoff raw-artifact limit blocks compact result reuse

- **Status:** new
- **Observed date:** 2026-08-14
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Multi-stage dashboard implementation using reconnaissance artifacts as input to a bounded implementation delegate
- **Harness component:** `delegate.handoffFrom` artifact transfer and structured-result views
- **Route / attempt / outcome:** A `luna-high` reconnaissance returned a valid structured result and artifact. A later `luna-xhigh` implementation delegate failed before launch because the selected artifact exceeded the 16,384-byte raw-artifact per-item limit.
- **Observed cost / rework:** The parent had to remove the handoff and manually restate the reconnaissance conclusions in the implementation prompt.
- **Recurrence / confidence:** Observed deterministically with a 20,345-byte structured-result artifact; high confidence.
- **Ticket:** —

## Behavior

`handoffFrom` validated the full raw artifact size even though the parent only needed its compact projected findings. The delegate failed setup before launch with an artifact-size error. No directly selectable default projection/summary view was available on that result, so the handoff feature could not reuse an otherwise valid, parent-visible artifact.

## Impact

Normal reconnaissance outputs can exceed the handoff limit, making artifact reuse unreliable for exactly the multi-stage orchestration workflow it is intended to support. Parents must either duplicate findings into prompts, anticipate and define custom views before knowing what later stages need, or omit useful evidence. This increases prompt size and context loss while making `handoffFrom` appear usable until delegate setup fails.

## Evidence

- Source artifact: a valid structured reconnaissance result, 20,345 bytes raw.
- `delegate` setup rejected it because each raw handoff artifact is limited to 16,384 bytes.
- The parent-visible projection contained the relevant client design, deletions, mismatch UI, tests, and demonstration guidance, but could not be selected as a built-in handoff representation.
- Retrying the same implementation request without `handoffFrom` launched successfully.
- Existing inbox titles cover artifact visibility/scope and view syntax; this report is limited to raw-size enforcement preventing reuse of a valid compact result.

## Smallest improvement

Make every structured delegate result expose an automatically generated bounded handoff view containing its projected result, and make `handoffFrom` use that view by default when the raw artifact exceeds the limit. Report the selected representation and size before launch. If no bounded representation exists, return a parent-actionable option to choose fields or summarize rather than rejecting the delegate setup outright.
