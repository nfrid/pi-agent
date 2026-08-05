# HFM-20260805: Add schema-driven delegate outputs

- **Status:** proposed
- **Approval:** approved 2026-08-05
- **Created:** 2026-08-05
- **Source reports:** [HF-20260805: Delegate completion truncates actionable audit findings](../inbox/20260805T111944Z-delegate-audit-findings-truncated.md)

## Problem

Delegate tasks currently return prose under a conventional set of headings. The harness heuristically extracts bounded conclusion, evidence, and risk fragments for the parent while preserving exact prose in an artifact. This is difficult to validate, cannot guarantee that required findings are present, and cannot selectively forward structured evidence to another delegate without either polluting parent context or forwarding an entire prose artifact.

## Baseline

An audit artifact containing four findings was 2,215 bytes and 13 lines, yet its completion exposed only the start of the first finding. `extensions/delegate/output.ts` extracts bounded fields from prose, and `handoffFrom` forwards whole delegate-output artifacts as untrusted evidence. The parent cannot declare a result contract, validate the child's result against it, select fields for its own compact envelope, or forward an exact schema-defined subset without reading it first.

## Hypothesis

If the parent can attach a bounded result schema and visibility policy to a delegate task, and the harness validates the child's structured result before completion, then required findings and identifiers will be reliably available, parent-visible context can stay small, and exact selected data can be handed to a later delegate without first entering the parent's model context.

## Guardrails

- Structured output remains untrusted child evidence; schema validity is not semantic correctness.
- Use a bounded declarative schema subset, not executable JavaScript, callbacks, or arbitrary workflow code.
- Preserve the full validated result in an immutable artifact owned by the launching session.
- Let the parent explicitly distinguish parent-visible summary fields from artifact-only fields; default to conservative bounded visibility.
- Enforce limits on schema size/depth, result bytes, arrays, strings, and parent projection.
- Reject unsupported schema features and fail clearly when required output is invalid or missing.
- Do not silently coerce malformed output into validity or parse prose heuristically as structured data.
- Preserve legacy prose behavior when no result schema is supplied.
- Keep cross-session artifact ownership, untrusted-evidence framing, and secret/content boundaries.

## Options considered

1. **Parent-provided bounded JSON Schema plus projection policy:** General, validated, and composable; requires result-mode protocol, validation, and careful context budgeting.
2. **Fixed harness-wide audit schema:** Solves finding lists cheaply but does not support different task contracts or selective handoff.
3. **Structured `Findings` prose field:** Improves this report but remains parser-dependent and cannot express broader contracts.
4. **Executable JS workflow/schema definitions:** Highly flexible, but creates a code-execution and lifecycle surface far beyond the observed output problem.
5. **Increase prose envelope limits:** Does not guarantee completeness or enable selective piping.

## Recommendation

Implement option 1 in a deliberately small first version. A delegate request may include a result specification containing:

- a bounded JSON-compatible schema for the complete result;
- a parent projection expressed as schema paths whose values are included in the compact completion under a separate byte cap; and
- named artifact views expressed as schema paths that can later be forwarded by handle and view name without exposing their bytes to the parent model.

The child should receive the schema and a machine-readable result channel rather than being asked to embed JSON in prose. The harness validates once at settlement; if invalid, it returns a structured failed/partial outcome with validation errors rather than pretending the task succeeded. The exact validated object is artifacted.

Future programmatic processing may add declarative predicates over validated fields—for example, forwarding only findings whose severity is `high`. The first version deliberately supports static schema-path projections only: no filter functions, expression language, or executable callbacks. This keeps the validation, visibility, ownership, and artifact foundations small enough to harden before dynamic workflows build on them.

## Scope

- **In:** Optional delegate result specification; bounded JSON-compatible schema subset; machine-readable child result channel; settlement validation; parent projections; immutable structured artifacts; named schema-path artifact views; forwarding a selected view as untrusted evidence; legacy prose fallback; single and parallel task behavior.
- **Out:** Executable schemas; filter functions or predicate expressions; JS-defined workflows; automatic task graphs; semantic grading; arbitrary JSONPath or transformations; cross-owner artifact access; model-generated schema execution; removal of prose tasks or exact artifacts. Declarative filtering over validated fields is a recorded future extension after the base contract is evaluated.

## Acceptance criteria

- [ ] A parent can supply a bounded supported schema with required fields, arrays, enums, objects, and primitive constraints.
- [ ] A child result is accepted only when it validates exactly; missing required findings or wrong types produce an explicit non-success result with bounded validation errors.
- [ ] The exact validated object is stored in an immutable delegate-output artifact without being copied wholesale into parent context.
- [ ] The compact completion contains only the parent projection plus mandatory lifecycle metadata and reports omitted/over-limit projected data deterministically.
- [ ] A parent can forward a named artifact view to a later delegate without retrieving its bytes into parent context; ownership and untrusted-evidence framing remain enforced.
- [ ] Schema paths cannot escape the validated result, execute code, perform arbitrary transformations, or access unselected artifact content.
- [ ] Parallel tasks each retain independent schemas, projections, validation results, and context budgets.
- [ ] Invalid schemas fail before child launch; invalid child results cannot be mislabeled successful.
- [ ] Tasks without a result specification retain the current prose report and artifact behavior.
- [ ] The original four-finding audit shape can require all finding titles/severities, show only their bounded index to the parent, and preserve detailed evidence artifact-only.

## Validation

Add fixtures for valid and invalid schemas, missing required fields, extra properties, nested arrays, enums, multibyte and over-limit strings, large results, projection overflow, malformed child settlement, legacy prose, parallel schemas, artifact ownership, named-view forwarding, and path-escape attempts. Assert that artifact-only values never occur in parent-visible output or tool details. Run focused delegate planning, child protocol, output, artifact, and handoff tests, then `npm run check`.

## Evaluation

- **Window:** After an approved merge, the first 15 schema-driven delegates across at least 3 task shapes, including 5 multi-finding reviews, or 2026-10-15, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline where three of four findings were absent and whole artifacts required retrieval. Keep only if every valid required field is preserved, every invalid result is detected, no artifact-only value leaks into parent context, at least 5 selected views are forwarded without parent retrieval, and schema overhead does not cause more than 2 of 15 eligible tasks to require a retry or prose fallback.

## Implementation and resolution

- **Approved implementation:** Add optional bounded schema-driven delegate results with exact settlement validation, immutable structured artifacts, static parent projections, and named artifact views that can be forwarded without parent retrieval. Preserve legacy prose behavior and ownership/untrusted-evidence boundaries. Defer filter functions, declarative predicates, and workflow execution until the base contract is hardened; approved by the user on 2026-08-05.
- **Merged change:** —
- **Resolution:** pending evaluation
