# HF-20260805: Delegate completion truncates actionable audit findings

- **Status:** parked
- **Observed date:** 2026-08-05
- **Source cwd/repo:** /Users/nfrid/.pi/agent
- **Task shape:** Background independent regression/security audit of a multi-package dashboard refactor
- **Harness component:** delegate completion envelope
- **Route / attempt / outcome:** luna-xhigh / one successful audit / actionable evidence truncated
- **Observed cost / rework:** Required a separate artifact retrieval before the parent could understand, prioritize, or assign the reported defects.
- **Recurrence / confidence:** Observed once in this session and similarly on multiple delegate completions; high confidence for reports with several findings.
- **Ticket:** —

## Triage decision

Parked on 2026-08-17 when the schema-driven result ticket was removed with its
superseded API. The underlying compact-handoff concern remains valid, but the
current prose report envelope and symbolic workflow inputs require a fresh
baseline before another proposal. Reconsider only after a current workflow
omits actionable findings from both its bounded envelope and exact report
artifact.

## Behavior

The successful audit completion exposed only the first finding fragment in its compact result. The conclusion said there were actionable issues, while the evidence ended mid-scenario and the risk summary only said ordering and empty-body issues remained. Two additional findings, their severities, and precise file evidence were available only in the attached artifact.

## Impact

A parent can miss findings or incorrectly scope follow-up work when the completion envelope truncates a short, structured audit report. Retrieving the artifact adds a tool round trip and context overhead before any decision can be made.

## Evidence

The audit artifact was 2,215 bytes and 13 lines, but the delivered completion included only the beginning of the first evidence item. Retrieving `art_Iz7LnIXWLdAejLen1aBwzg` revealed four findings: two transport-ordering defects, empty-body route parity, and widened JSON buffering.

## Smallest improvement

For review/audit delegates, preserve every finding's severity and one-line title in the compact completion envelope, truncating detailed evidence before truncating the finding index.
