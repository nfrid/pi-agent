# Todo context

The todo extension keeps task state available to the model without rewriting persisted session history.

## Context model

- At the start of each user turn, the extension persists one immutable snapshot of the current todo state; inactive state reuses a matching persisted reset instead of emitting another identical snapshot.
- Todo tool results after the newest snapshot remain exact because they describe changes made during that turn.
- Across older turns, the first six todo results remain exact as a stable prefix; later old results are replaced only in the cloned provider request with a neutral elision marker.
- Existing snapshots are never refreshed or moved.
- Todo mutations return bounded text summaries plus structured records for affected caller-supplied IDs and current stats. `todo_list` returns the selected task records and stats with a bounded text view. Validation failures and actionable dependency blockers remain explicit; the tool API has no batch action selector.
- Each distinct inactive state emits one reset anchor. Unchanged later turns reuse that anchor and append nothing; if completed-only state changes, one replacement reset is persisted. Prior session history is not rewritten.
- If a snapshot is missing, or session compaction/tree restoration requires recovery, the provider context receives a current trailing snapshot while retaining exact state evidence.

This layout preserves task recall across normal turns, compaction, and forks while keeping the reusable provider-cache prefix stable. There is no runtime mode switch.

## Commands

- `/todo` refreshes the task widget and shows current state in a notification in TUI mode; it prints current state elsewhere.
- `/todump` inserts the current todo state into the editor in TUI mode and prints it elsewhere.

Use `todo_list` to read current tasks, `todo_update` to apply an atomic array of changes, and `todo_remove` to remove tasks by ID so snapshots and later tool results remain authoritative.

`todo_update` creates tasks for new caller-supplied IDs (requiring `text`, defaulting to `todo`) and updates only supplied fields for existing IDs. Changes may reference tasks created in the same request. Set `status` directly to start, complete, block, or drop a task. `todo_remove` rejects removal when a retained task depends on a removed task. Completed tasks remain available with `todo_list({"include_done":true})`.
