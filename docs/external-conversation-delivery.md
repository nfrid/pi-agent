# External conversation delivery (v1)

Telegram uses:

- `POST /api/external/v1/projects/:projectId/deliveries`
- `GET /api/external/v1/projects/:projectId/deliveries/:deliveryId`
- `GET /api/external/v1/projects/:projectId/models`
- `POST /api/external/v1/projects/:projectId/conversations/settle`

All require `Authorization: Bearer <dashboard-token>`, including requests with a browser Origin. `x-dashboard-token` is not accepted on delivery endpoints. Originless Bearer requests are supported; a supplied unapproved Origin is rejected. URL-encode opaque path IDs.

```json
{
  "deliveryId": "telegram-update-123",
  "conversationRef": "telegram-chat-456",
  "text": "Inspect the latest build.",
  "attachments": [{"name":"report.txt","mimeType":"text/plain","data":"aGVsbG8="}]
}
```

Exactly one of `threadId` and `conversationRef` is required. IDs and text are preserved, not trimmed. `deliveryId` is at most 256 characters with no control characters. Text or at least one attachment is required; unknown properties are rejected.

IDs and conversation links are project-scoped. First-use conversations create a normal isolated project thread titled **Telegram**, using an optional explicit `model: {provider, model, thinking?, serviceTier?}` or normal server defaults when omitted. An explicit initial selection is validated against the installed available model catalogue and supported effort levels before admission; an unavailable choice is rejected without consuming the delivery ID, never silently replaced. The selection participates in the immutable delivery fingerprint. It applies only to creation, not existing conversations. The models endpoint returns `{models: [{provider, model, name, thinkingLevels}]}` without model inference or catalogue-network refresh. No empty setup prompt is sent. Existing threads must belong to that project and must not be archived. Dormant threads resume their known indexed session through the existing durable runtime-start lifecycle, without an initial prompt; missing/unavailable resume evidence is not permission to start an unrelated session.

## Responses and retries

POST returns 202; GET returns 200. Both success bodies have only:

```json
{"deliveryId":"telegram-update-123","threadId":"thread-id","state":"completed","reply":{"text":"The answer.","messageId":"persisted-entry-id"}}
```

`state` is `pending`, `running`, `completed`, or `attention`. `reply` exists only on completion. Attention includes `error: {code,message}`. Internal prompts, fingerprints, and artifact paths are never returned.

An identical POST returns the existing record; changed payloads return `409` with `code: "idempotency-conflict"`, including concurrent requests. Definite busy rejection returns `409` with `code: "busy"` without reserving a new delivery ID. If a record was already prepared before a daemon exit, retry the identical POST to progress it. GET never launches or dispatches anything; there is no additional delivery worker. Keep polling a running turn, and use identical POST retries for pending setup/recovery. Admission to a thread is held until its delivery is observed terminal, even if the runtime's last snapshot still says idle.

## Ownership and crash behavior

A delivery-specific marker is included in the actual user message. Completion requires its unique canonical user entry on the persisted selected branch, ancestry from the pre-send leaf (normal leaf advancement is allowed), the same session/runtime, and a settled live runtime. A final reply must have native `stopReason: "stop"`, contain no tool calls, and be the sole final assistant message after that user entry. Thinking and intermediate tool-use commentary are excluded. An intervening user, removed anchor, replacement runtime/session, multiple final messages, aborted/length-limited output, or oversized output yields attention. Replies are bounded to 256 KiB UTF-8, never silently truncated.

Missing transcript data during index/bridge lag remains pending. Completed/attention results are frozen atomically in SQLite and cannot change when later messages arrive. Send intent is durable before dispatch, including the first orchestration hello. A genuine restart with an ambiguous dispatched send yields attention, never a speculative resend. An actively owned in-process dispatch is still running, not restart uncertainty.

This is not an arbitrary background-turn correlation protocol. Background activity producing additional user/final messages, compaction removing required evidence, and lost runtime/session evidence can require human attention. Do not replace an attention delivery with a new ID automatically: its original action may have executed. A live runtime that disappears without terminal evidence can remain pending until it reconnects or a terminal lifecycle observation arrives.

## Idle conversation retirement

POST `/conversations/settle` with `{commandId, conversationRef}`. The reference is resolved only within the requested active project; IDs are bounded to 256 characters. No arbitrary runtime ID or force flag is accepted. Results are `{state: "settled" | "absent" | "superseded", threadId?}` and are durably idempotent; reusing an ID for another reference conflicts. A completed close is never repeated against a subsequently reopened thread. A pending retry targeting a replaced runtime becomes superseded instead of stopping the new generation.

The caller must drain its own accepted messages/outgoing replies first. An active external delivery or runtime returns retryable `409 busy`. Dashboard command admission is fenced during retirement, and the runtime must acknowledge `shutdown` with `onlyIfIdle: true` after checking active and queued work. Errors, timeout, disconnected/unmanaged runtimes and older protocol implementations never fall through to forced process termination. An idle legacy runtime needs an explicit verified refresh before it supports this additive command; ordinary Dashboard deployment does not restart runtimes or hosts.

Old replies still resume the same indexed session without a setup prompt; successful input unsets the settled marker even if the session link has not caught up yet. Retirement does not delete history, memory or artifacts.

The visible `[[PI_EXTERNAL_DELIVERY:…]]` marker is still intentional. It disambiguates repeated identical user messages in persisted branches and disables native slash/skill/template expansion for external text. Durable delivery receipts, not the marker alone, provide replay protection. Removing it requires another persisted caller-message correlation mechanism, not simply a display/text cleanup.

## Attachments

At most four attachments, at most 10 MiB decoded total, canonical padded base64, and a bounded JSON body (14 MiB + 256 KiB) are accepted. Original names and MIME types are untrusted JSON-escaped metadata. Only server-derived digest directories and opaque filenames are used; no host path/URL input or execution is supported. Private directories/files are owner-only. Existing artifacts must match bytes and private ownership/mode; symlinks and nonregular files are rejected. Failed preparation removes only files created by that operation.

Raster files retain `.png`, `.jpg`, or `.webp` extensions. Images up to the existing 5 MiB native-image limit use the native path as well as a private manifest. Other files are evidence available to normal read/CLI tools, not fabricated extracted text. After an initial-image cache loss, the persisted manifest remains available. Accepted artifacts are retained because the session may refer to them on later turns; no public file-read route or automatic retention collector is added.
