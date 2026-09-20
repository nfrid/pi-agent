# External conversation delivery (v1)

Telegram uses:

- `POST /api/external/v1/projects/:projectId/deliveries`
- `GET /api/external/v1/projects/:projectId/deliveries/:deliveryId`

Both require `Authorization: Bearer <dashboard-token>`, including requests with a browser Origin. `x-dashboard-token` is not accepted on delivery endpoints. Originless Bearer requests are supported; a supplied unapproved Origin is rejected. URL-encode opaque path IDs.

```json
{
  "deliveryId": "telegram-update-123",
  "conversationRef": "telegram-chat-456",
  "text": "Inspect the latest build.",
  "attachments": [{"name":"report.txt","mimeType":"text/plain","data":"aGVsbG8="}]
}
```

Exactly one of `threadId` and `conversationRef` is required. IDs and text are preserved, not trimmed. `deliveryId` is at most 256 characters with no control characters. Text or at least one attachment is required; unknown properties are rejected.

IDs and conversation links are project-scoped. First-use conversations create a normal isolated project thread titled **Telegram**, using normal server model defaults. No empty setup prompt is sent. Existing threads must belong to that project and must not be archived. Dormant threads resume their known indexed session through the existing durable runtime-start lifecycle, without an initial prompt; missing/unavailable resume evidence is not permission to start an unrelated session.

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

## Attachments

At most four attachments, at most 10 MiB decoded total, canonical padded base64, and a bounded JSON body (14 MiB + 256 KiB) are accepted. Original names and MIME types are untrusted JSON-escaped metadata. Only server-derived digest directories and opaque filenames are used; no host path/URL input or execution is supported. Private directories/files are owner-only. Existing artifacts must match bytes and private ownership/mode; symlinks and nonregular files are rejected. Failed preparation removes only files created by that operation.

Raster files retain `.png`, `.jpg`, or `.webp` extensions. Images up to the existing 5 MiB native-image limit use the native path as well as a private manifest. Other files are evidence available to normal read/CLI tools, not fabricated extracted text. After an initial-image cache loss, the persisted manifest remains available. Accepted artifacts are retained because the session may refer to them on later turns; no public file-read route or automatic retention collector is added.
