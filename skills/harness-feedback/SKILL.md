---
name: harness-feedback
description: Capture up to three actionable Pi harness-friction reports when explicitly invoked by the user.
---

# Harness feedback

Use this skill only when the user explicitly invokes it to capture friction in the
Pi harness: delegation, routing, tools, prompts, runtime behavior, global
skills/configuration, or harness ergonomics. Do not report product bugs or
policy owned by the current project.

## Write authorization and scope

The explicit invocation authorizes writing up to **three** new reports for this
invocation; do not ask for a second confirmation. Keep observations grounded in
this task/session, separate facts from assumptions, and omit preferences,
speculation, and low-signal one-off mistakes. Never copy raw transcripts,
secrets, credentials, private data, or large logs.

Capture only friction or capability gaps whose evidence supports a concrete
harness change. Every report must identify behavior worth changing and a
smallest useful improvement. Do not create reports merely to confirm that a
route, tool, prompt, skill, or runtime behavior worked as intended.

If delegates were used in the current task, compare only the exercised routes
with their `use for` and `avoid` descriptions before choosing reports. Capture a
route-description report only when a concrete mismatch caused or risked a poor
selection, unnecessary escalation, rework, or an unsuitable result. Do not
report positive fit, and do not evaluate routes or `avoid` claims that the task
did not exercise.

## Fixed canonical store

Never use the current working directory for feedback storage. Resolve this
skill's directory (normally `~/.pi/agent/skills/harness-feedback/`) and read
both `../../.agents/feedback/README.md` and
`../../.agents/feedback/REPORT_TEMPLATE.md` completely before writing. These
resolve to the canonical store at `~/.pi/agent/.agents/feedback/`; its fixed
inbox is `~/.pi/agent/.agents/feedback/inbox/`, even when the current directory
is another repository. Follow the README and template for report fields.

Before each write, inspect only existing inbox report titles for an obvious
duplicate. Do not investigate, triage, or compare beyond that title scan. Skip
an obvious duplicate; otherwise fill the template with concise evidence and
write a unique UTC-named Markdown file (for example,
`YYYYMMDDTHHMMSSZ-slug.md`; add a collision suffix when needed) with `Status:
new`. Write no more than three reports.

## Hard boundaries

This skill captures reports only. It must not triage reports, create tickets,
approve work, implement fixes, commit, or alter routing. Its only permitted
write is a new report in the fixed canonical inbox, including when the harness
repository itself is the current project; it must not modify any other
current-project file.
