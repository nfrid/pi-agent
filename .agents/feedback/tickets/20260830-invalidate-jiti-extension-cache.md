# HFM-20260830: Invalidate Jiti extension cache on source changes

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-08-30
- **Source reports:** [HF-20260812: Jiti extension cache survives source updates and fresh Pi launches](../inbox/20260812T074623Z-jiti-cache-survives-source-updates.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

A fresh Pi process can execute stale transpiled extension code after an extension or transitive TypeScript module changes, making correct source edits appear ineffective and causing misdiagnosis and workaround code.

## Baseline

The source report records repeated fresh-process loads of a stale `node_modules/.cache/jiti/delegate-events.*.mjs` entry until the cache directory was removed. At the current 0.84.1 baseline, Pi's installed extension loader still creates Jiti with `moduleCache: false` but does not explicitly disable its filesystem cache. No harness check proves that changing a transitive extension module changes the code loaded by a new process.

## Hypothesis

If extension loading either disables Jiti's filesystem cache or validates every cached transform against current source content and transitive dependencies, then a fresh Pi process will execute the current extension sources without manual cache deletion, because stale transpiled entries will no longer be accepted across launches.

## Guardrails

- Preserve TypeScript extension loading, virtual modules, aliases, and source-runtime behavior.
- Do not require users to clear all package or provider caches.
- Keep process startup cost bounded and measure any regression.
- Do not add a repository-owned cache invalidation daemon or watcher.
- Runtime reload behavior remains out of scope; this ticket concerns fresh-process correctness.

## Options considered

1. **Disable Jiti filesystem caching for extensions:** Smallest correctness boundary; may add repeat transpilation cost at process startup.
2. **Use content/dependency-aware cache keys:** Retains caching but requires proof that transitive changes invalidate the entry.
3. **Document manual cache deletion:** Leaves fresh launches capable of running stale code and preserves the debugging hazard.

## Recommendation

Prefer option 1 unless focused startup measurements show a material regression; otherwise implement option 2 with explicit transitive-module fixtures. Fresh-process correctness is more important than an unmeasured extension transpilation cache benefit.

## Scope

- **In:** Pi extension-loader Jiti configuration; direct and transitive TypeScript source changes; fresh-process tests; bounded startup measurement.
- **Out:** Same-process hot reload; provider response caches; package-manager caches; general build caching.

## Acceptance criteria

- [ ] After changing a direct extension module, a fresh Pi process executes the changed behavior without deleting cache files.
- [ ] After changing a transitive imported TypeScript module, a fresh Pi process executes the changed behavior without deleting cache files.
- [ ] Repeated unchanged launches retain correct extension loading and do not create unbounded cache growth.
- [ ] Existing virtual-module, alias, and compiled/source runtime fixtures continue to pass.
- [ ] The chosen policy and measured startup effect are documented in the change.

## Validation

Run a real-process fixture twice for direct and transitive module edits while preserving the cache directory between launches, and assert the second process emits the new sentinel. Cover source Node, built Node, and Bun-binary modes where supported; inspect cache files only as diagnostic evidence. Run focused Pi extension-loader tests and the upstream package check required by that repository.

## Evaluation

- **Window:** Not started; after an approved merge, the first 10 extension-development restarts including at least 3 transitive-module edits, or 2026-10-31, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of repeated stale fresh launches and manual cache removal. Keep only if every observed restart runs current source, no manual cache purge is needed, and startup cost remains acceptable.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
