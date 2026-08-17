# Pi harness feedback

This is the canonical feedback store for Pi harness behavior and capabilities. Reports can be captured while the agent is working in any repository.

## Capture

- Invoke the global `harness-feedback` skill from any repository. It writes new reports to this directory's [`inbox/`](inbox/), regardless of the current working directory.
- An explicit invocation authorizes up to three **new, append-only reports**. Capture does not rewrite existing reports.
- Reports must concern the Pi harness: for example, its routes, attempts, capabilities, or observable behavior. Product bugs and project-owned `AGENTS.md`, skills, or workflow feedback belong to that project's process, not here.
- Global capture records observations only. It does not triage reports, create tickets, implement changes, or evaluate them.
- There is no automatic capture, automatic route edits, external sync, or raw transcripts.

## Maintenance

The local `harness-maintenance` skill handles triage, ticket preparation, separately approved implementation, and evaluation. Keep proposal and implementation approval separate; a report is not a ticket and a ticket is not implementation authorization.

## Delegate review snapshots

A successful unchanged read-only delegate in worktree isolation is retained as a resumable Git snapshot, not an integration branch. Its checkout is retired automatically; continue it without a refresh selector to recreate the exact original source (including its carried WIP snapshot). For targeted verification after fixes, a read-only continuation can explicitly refresh from current `wip` or `head`; a refreshed continuation preserves the reviewer's context but is not independent evidence. Use a fresh delegate for an independent regression review. Writable delegate branches and failed, aborted, timed-out, lifecycle-error, or changed read-only worktrees retain their existing review and recovery lifecycle.

## Layout and links

- [`REPORT_TEMPLATE.md`](REPORT_TEMPLATE.md) — concise harness observation
- [`inbox/`](inbox/) — captured reports awaiting triage
- [`TICKET_TEMPLATE.md`](TICKET_TEMPLATE.md) — decision-ready harness proposal
- [`tickets/`](tickets/) — proposals and evaluation records

Reports in `inbox/` link to tickets as `../tickets/<file>.md`; tickets link back to every source report as `../inbox/<file>.md`. Normal triage keeps source reports in place. An explicit maintenance cleanup may delete wholly superseded reports and tickets after confirming no unresolved concern depends on them and repairing every surviving link; Git history is the archive.
