# Repository-local workflow feedback

This is the Pi repository's small, local way to turn observed Pi workflow friction into proposed improvements. It is not a product tracker. File each observation where the likely fix belongs; see ownership below.

## Operating rules

- **Manual or explicit event only.** A user must ask for feedback, a retrospective, or triage. There are no hooks, watchers, background capture, or automatic routing edits.
- **Evidence first.** Start with deterministic evidence from the current task: commands, paths, messages, and observable behavior. Separate facts from hypotheses; do not add a report for a preference or unsupported idea.
- **Draft before writing.** During one retrospective, draft at most three observations in the conversation. Show them to the user and write only the observations the user explicitly approves. If approval is not given, leave the repository unchanged.
- **Keep reports small.** Put approved observations in `inbox/` using `REPORT_TEMPLATE.md`. Do not copy raw transcripts, secrets, credentials, private data, or large logs.
- **Triage is separate.** Triage happens only when requested. It may mark reports `triaged`, `duplicate`, or `parked`, and may create a local ticket, but it does not approve implementation.
- **Implementation is separate.** A ticket is a proposal. Implementation requires a distinct approval and request. Merging a change does not finish evaluation: the ticket remains `evaluation-pending` until its evaluation window has ended and a result is recorded.

## Ownership and links

File feedback where the likely fix belongs: Pi agent/tooling or this repository's workflow goes in `.agents/feedback/`; MyGig workspace workflow goes in `~/job/.agents/feedback/`. Each location has local ownership by that workspace's maintainers. When an observation spans both, keep one canonical report at the likely-fix location and cross-link to the other workspace's existing report or ticket instead of duplicating it. Do not silently write to the other workspace.

Within a workspace, use relative Markdown links for the cross-link: once a ticket exists, its source report must link to that ticket and the ticket must link back to every source report. A report with no ticket uses `—`. Do not delete source reports to hide the history.

## Layout

- `REPORT_TEMPLATE.md` — concise, user-approved observation format
- `inbox/` — approved reports for this workspace awaiting triage
- `TICKET_TEMPLATE.md` — decision-ready local proposal
- `tickets/` — proposed and evaluated local tickets for this workspace

Do not add a taxonomy, archive, database, external synchronization, automatic route edits, or transcript store. Keep the workflow useful without creating process work.
