---
name: workflow-feedback
description: Capture and triage concise, repository-local workflow observations after an explicit user request or retrospective event.
---

# Workflow feedback

Use this skill only for workflow friction in this repository: policy, skills, agent ergonomics, or local tooling. Product defects belong in the product repository's own process.

## Authority and trigger

This is **manual/event-triggered only**. Act when the user explicitly asks for feedback, a retrospective, or triage, or names an equivalent workflow event. Do not watch work, infer a trigger silently, or add hooks and automatic routing.

A draft is not a write authorization. First present no more than **three** draft observations for the retrospective. Write only the observations the user explicitly approves. If the user does not approve them, do not create or edit feedback artifacts. The primary task remains more important than feedback.

## Draft observations

For each candidate:

1. Verify it was observed in the current task or follows directly from deterministic evidence already collected.
2. State the behavior, impact, evidence, smallest useful outcome, and compact context: source session/task shape, route/attempt/outcome when relevant, observed cost or rework, and confidence/recurrence. Label assumptions; do not turn guesses into facts.
3. Skip one-off mistakes, preferences, speculative solutions, duplicates, and low-signal friction.
4. Present the drafts together and wait for explicit approval. Never write raw transcripts or unapproved drafts.

After approval, file the report where the likely fix belongs: use this repository's `../../feedback/inbox/` for Pi agent/tooling and local workflow issues, or `~/job/.agents/feedback/inbox/` for MyGig workspace workflow issues. If an observation spans both, keep one canonical report and cross-link the other existing artifact rather than duplicate it; do not silently write to the other workspace. Fill the template with concise evidence and set `Approval: user-approved`. Scan existing report titles only for an obvious duplicate; do not start a separate investigation. Mention the approved report path in the completion summary.

## Triage

Triage is an explicit, separate request. Process a bounded set (by default, reports with `Status: new`) and inspect existing tickets before creating another.

For each report, choose `triaged`, `duplicate`, or `parked`. For an actionable group, create one ticket from `../../feedback/TICKET_TEMPLATE.md` and cite every source report. A ticket must include:

- the verified **baseline** and its evidence;
- a falsifiable **hypothesis**;
- **guardrails** and non-goals;
- acceptance criteria;
- **validation** commands or inspection against the baseline and guardrails; and
- an **evaluation window** with a pending result, later choosing `keep`, `revise`, `revert`, or `insufficient evidence`.

Update the source report's status and ticket link, and keep the ticket's source links pointed back to all reports. This relative-link pair is required; leave source reports in place. Keep ownership with the workspace where the likely fix belongs.

Triage, ticket creation, and ticket approval are different actions. Creating or approving a ticket does not authorize implementation; implementation needs a separate explicit request. Do not create external tickets or sync systems.

## Implementation and evaluation handoff

When a separately approved ticket is implemented, record the merged change but set the ticket status to `evaluation-pending`—not resolved—after merge. Observe the stated evaluation window, compare the result with the baseline, and record the result and date before marking the ticket evaluated. Do not silently change routes or broaden scope.

## Boundaries

Do not add a taxonomy, archive, database, external synchronization, automatic route edits, or raw-transcript storage. Keep each artifact in the feedback directory of its owning workspace, and keep the process concise and operational.
