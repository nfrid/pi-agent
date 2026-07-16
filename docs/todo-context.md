# Todo context

The todo extension keeps task state available to the model without rewriting persisted session history.

## Context model

- At the start of each user turn, the extension persists one immutable snapshot of the current todo state.
- Todo tool results after the newest snapshot remain exact because they describe changes made during that turn.
- Across older turns, the first six todo results remain exact as a stable prefix; later old results are replaced only in the cloned provider request with a neutral elision marker.
- Existing snapshots are never refreshed or moved.
- If a snapshot is missing, or session compaction/tree restoration requires recovery, the provider context receives a current trailing snapshot while retaining exact state evidence.

This layout preserves task recall across normal turns, compaction, and forks while keeping the reusable provider-cache prefix stable. There is no runtime mode switch.

## Commands

- `/todo` opens the task overlay in TUI mode and prints current state elsewhere.
- `/todump` inserts the current todo state into the editor.
- `/tostats` shows aggregate task counts.

Use the `todo` tool for state changes so snapshots and later tool results remain authoritative.
