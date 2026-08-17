---
name: harness-maintenance
description: Triage and maintain Pi harness-feedback reports and approved improvements in this harness repository.
---

# Harness maintenance

Use this project-local skill only while operating in this Pi harness repository.
Its artifacts live under `.agents/feedback/`; resolve that directory relative to
this skill as `../../feedback/`. Read its `README.md` and the relevant report or
ticket template before changing feedback artifacts.

## Bounded triage

Triage is a separate, explicit request. Process a bounded batch (by default,
reports whose status is `new`), inspect the report evidence and existing tickets,
and choose `triaged`, `duplicate`, or `parked`. Scan for duplicates before
grouping; keep source reports in place during normal triage. For an actionable
group, create one decision-ready ticket from `TICKET_TEMPLATE.md`, link every
source report in both directions, and record:

- the verified baseline and evidence;
- a falsifiable hypothesis;
- guardrails and non-goals;
- acceptance criteria; and
- validation steps plus an evaluation window with a pending result.

Triage and ticket creation do not approve a ticket or authorize implementation.
Do not create external tickets or silently broaden the batch or scope.

## Approved implementation and evaluation

Implement only a separately approved or explicitly requested ticket. Use normal
project orchestration, focused tests, and the repository's checks (including
`npm run check` when applicable); do not turn triage into autonomous
implementation. Record the merged change, then leave the ticket
`evaluation-pending` rather than resolved. At the end of its stated evaluation
window, compare the result with the baseline and record the date and one result:
`keep`, `revise`, `revert`, or `insufficient evidence`.

Keep triage, approval, implementation, and post-merge evaluation as distinct
steps. A separately requested cleanup may delete reports and tickets whose
behavior and proposed remedy are wholly superseded at the current baseline;
verify that no unresolved concern depends on them, repair surviving links, and
rely on Git history rather than creating an archive. Do not add taxonomies,
archives, databases, automatic routing, transcript stores, or unrelated project
changes.
