# HF-20260812: Jiti extension cache survives source updates and fresh Pi launches

- **Status:** triaged
- **Observed date:** 2026-08-12
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Diagnose why newly added delegate transcript capture was absent after rebuilding and restarting Pi.
- **Harness component:** Pi TypeScript extension loader / Jiti filesystem cache
- **Route / attempt / outcome:** No delegate route was used for diagnosis; multiple fresh interactive Pi processes reproduced stale extension behavior.
- **Observed cost / rework:** Misdiagnosed a working source change as a data-pipeline defect, added and then replaced an unnecessary bridge, and required repeated restarts and live inspection.
- **Recurrence / confidence:** Directly observed; high confidence for edited transitive extension modules.
- **Ticket:** [HFM-20260830: Invalidate Jiti extension cache on source changes](../tickets/20260830-invalidate-jiti-extension-cache.md)

## Behavior

Fresh Pi processes loaded stale transpiled delegate modules from `node_modules/.cache/jiti` after the TypeScript sources had changed. Restarting Pi did not invalidate those entries.

## Impact

Source edits can appear ineffective even after a clean runtime restart. This obscures the actual running code and drives unnecessary debugging or workaround code.

## Evidence

- `extensions/delegate/events.ts` had a 2026-08-12 modification time and contained bounded thinking/tool transcript capture.
- `node_modules/.cache/jiti/delegate-events.ef4bafd8.mjs` was dated 2026-07-28 and contained the older parser (`MAX_ACTIVITY_COUNT = 20`, no tool payload capture).
- Fresh Pi processes still produced transcript entries without thinking bodies or tool arguments/results until the cache directory was removed.
- Jiti's cached file carried a valid cache footer, so the loader accepted it rather than retranspiling the changed source.

## Smallest improvement

Ensure extension loading invalidates or rebuilds Jiti filesystem cache entries when the source content changes, including transitive modules, so a fresh Pi process always runs current extension sources without manual cache deletion.
