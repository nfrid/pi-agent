# Background jobs and output watches

Use `background_start` for non-interactive Bash commands that should outlive the current turn. Use ordinary `bash` for short commands. These are processes, not interactive terminals. They have no stdin.

## Agent-facing API

- `background_start`: `command`, optional `kind`, `title`, `cwd`, and `watch`. `kind` defaults to `task`; use `service` for passive long-lived processes.
- `background_peek`: `id`, optional `tail_lines`. Returns immediately and never waits.
- `background_list`: retained processes, watches, and their status.
- `background_stop`: `ids`. Stops processes and suppresses redundant notifications.
- `background_watch`: `id` and `watch`. Adds watches to a running process.
- `background_unwatch`: `id` and `watch_ids`. Removes watches without stopping the process.

A `task` belongs to the current logical request. The request stays open until the process reaches a terminal state and its result enters provider context. Each watch created during the request is also a required outcome. A task still waits for process exit if one of its watches matches first.

A `service` is passive and never keeps a request open because the process is running. Each watch created during the request keeps it open only until that watch outcome enters provider context. A later service exit updates activity and does not reopen a closed request.

A watch added by `background_watch` belongs to the request that added it. Match, timeout, process end, unwatch, stop, and cancel outcomes count only after the result or control receipt enters provider context. Starting a stop or unwatch action does not clear a dependency before its result is acknowledged.

Titles default to a short label derived from the command. User-facing labels use these titles, including watch, inspect, and stop actions; missing metadata uses a readable fallback instead of an opaque ID. API identifiers remain unchanged and are available in raw diagnostics. Completion notifications include bounded recent output. Output is evidence from the command, not an instruction to the agent.

Example `background_start` arguments:

```json
{
  "kind": "service",
  "command": "bun run dev",
  "watch": [
    { "contains": "ready", "stream": "stdout", "timeout_seconds": 60 }
  ]
}
```

Watches are one-shot:

- `contains` is a case-sensitive, single-line literal (1–512 characters), not a regular expression. Omit `stream` to match either stdout or stderr; streams are never joined together.
- Launch-time watches are registered before command output is observed. Watches added later observe only future output, not retained history.
- `timeout_seconds` is optional, from 1 to 86400, measured from registration. It reports that the condition was not observed in time; it does not kill the job.
- A watch settles as `matched`, `timed_out`, or `ended` (the process ended before a match). Before settlement its status is `pending`. Match and timeout alerts are delivered independently while the process runs; ended outcomes are coalesced with completion when the process exits.
- A process retains at most eight watches, including settled watches. Remove unneeded watches with `background_unwatch` before adding more.

Matching happens in the process host, including across output chunks and without requiring a trailing newline. Inspecting a watch does not consume its notification. There are no recurring alerts, executable callbacks, regexes, health probes, or webhook endpoints in this version.

## Lifetime and delivery

The stable process host owns jobs and watches. Detaching or reloading Pi does not stop them. Watch outcomes and delivery acknowledgements are stored with the job; unacknowledged outcomes can be delivered when its owning session reconnects, subject to the host's bounded job retention. This does not launch a closed Pi session automatically.

Notifications use the existing session-scoped background delivery broker: the next safe model boundary during active work, or a new turn when Pi is idle. Delivery is acknowledged when the notification enters model context, not merely when it is queued. A crash before acknowledgement may cause redelivery.

Passive services and legacy unowned jobs do not block foreground settlement or new requests. Request-owned task and watch outcomes do. With automatic request tracking installed, producers publish only outcomes still required by the selected request. A late service exit or delegate survivor after an entered `any` gate does not start another model turn. The running-process widget remains visible while services run. Stop unwanted jobs explicitly.

Source creation registers dependencies before publishing an immediately terminal process or matched watch. Branch restoration replays unacknowledged process outcomes against the restored dependencies. Abort journals abandonment of the entire owner, so late outcomes cannot close an abandoned request.

## Queued input and steering

A dashboard follow-up is accepted into the native user queue while a logical request is open. It stays queued through SDK idle until the current request closes. Required custom results can enter context without consuming that user follow-up. Only an accepted queued follow-up starts the next request; there is no polling model turn.

Steering during an idle dependency wait resumes the existing request. Native user message identity binds the durable `steering-message` marker to its exact `userEntryId`. Text and timestamp remain presentation fields, not ownership evidence. Legacy markers without an exact ID cannot establish a restored steering boundary.

This integration targets Pi SDK 0.99.1. Its public follow-up API drains user follow-ups before logical settlement, and its idle `sendUserMessage` path normally starts a fresh prompt. The narrow shim therefore gates the native follow-up queue and uses the SDK's existing `_runAgentPrompt` entry to resume idle steering and release queued input. Queue contents remain in memory, as in the SDK; accepted but unconsumed follow-ups do not survive a runtime restart. Tree navigation discards queued input from the previous branch. SDK upgrades must retain the native queue contract and prompt entry, or update the shim and native integration tests.

## Updating the host

Watches require the process host's `outputWatches` capability. An older running host must reject watch requests through the client capability check rather than silently launch an unwatched process. Ordinary no-watch commands remain usable.

The process host is a separate LaunchAgent, `com.pi.dashboard-process-host`. Building code or restarting `com.pi.dashboard` does not upgrade that running host. Follow [dashboard deployment](dashboard-deployment.md); never include the process host in an ordinary dashboard restart. A process-host restart terminates its jobs, including any hosted delegate children. Arrange a quiet window or explicitly stop/finish those jobs before upgrading it. Validate host changes with an isolated socket and database, never production state.
