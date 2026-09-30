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

`state` is `pending`, `running`, `completed`, or `attention` for ordinary deliveries. Secondary steering acknowledgements use `accepted`. `reply` exists only on completion. Attention includes `error: {code,message}`. Internal prompts, fingerprints, and artifact paths are never returned.

An identical POST returns the existing record; changed payloads return `409` with `code: "idempotency-conflict"`, including concurrent requests. Definite busy rejection returns `409` with `code: "busy"` without reserving a new delivery ID. If a record was already prepared before a daemon exit, retry the identical POST to progress it. GET never launches or dispatches anything; there is no additional delivery worker. Keep polling a running turn, and use identical POST retries for pending setup/recovery. Admission to a thread is held until its delivery is observed terminal, even if the runtime's last snapshot still says idle.

## Source-bound user contact

`GET /api/external/v1/sessions/:sessionId/source` is Bearer-only, including originless machine calls. It returns `{projectId, threadId, sessionId, title}` for one existing canonical current source. It does not adopt sessions or create projects/threads. Ambiguous run/link ownership, archived projects/threads, missing runs and superseded sessions fail closed.

Replies to a question can include `expectedSessionId` with an explicit `threadId`. The field participates in the immutable delivery fingerprint. The server checks the latest run and live runtime before dispatch, and a v2 runtime checks its actual native session before accepting the prompt. A definitely unsent prepared request whose source is replaced is released rather than blocking the thread forever. Completed results remain frozen even if the source later changes. A missing v2 capability is retryable busy before admission, never an unfenced fallback.

This contract supports admin's owner-only Telegram outbox. Native source identity comes from the calling Pi session, not a model-selected target thread or recipient. Button answers are literal user input, not remotely executable commands.

## Active Reply steering

An explicit source Reply uses this stable POST payload:

```json
{"deliveryId":"update-123","threadId":"thread-id","expectedSessionId":"session-id","mode":"reply","coalesceConversation":true,"text":"Reply text"}
```

Freeze the complete body, including attachment metadata and bytes, before the
first request. The server selects native steering when the runtime is working
and advertises external-steering support. When it is idle or waiting, the server
selects the existing structured correlated prompt. A receiver with v2 structured
delivery but no steering support returns retryable `409 busy` while active;
retry the unchanged payload after it becomes idle. A receiver without v2 source
fencing remains busy. The idle prompt still requires structured source fencing
and receipts. This does not force a runtime refresh.

`mode: "steer"` remains the strict active-steering operation. Omitted mode retains the
existing idle prompt behavior. Both modes require an explicit thread and session
for source fencing. Coalescing changes output ownership only, not who may send
input. Source Reply never creates a conversation or chooses a new session.

The server dispatches a literal native steering message through the existing
public SDK queue. A dispatch-scoped local public-method shim enqueues with
`AgentCore.steer`; ordinary SDK calls retain their original implementation. This
avoids the fire-and-forget extension API's asynchronous acceptance gap. It also
bypasses extension input transformations, slash, skill and template expansion. The
runtime checks the actual native session and selected branch ancestry
immediately before queueing. Normal leaf advancement is allowed; a fork that
removes the admission anchor is rejected. A runtime that becomes idle between
server selection and queue admission rejects with retryable `busy`, without
sending the message. Retrying the identical `mode: "reply"` payload after the
idle transition selects the correlated prompt path. The active tool is not
interrupted; native steering is processed at the SDK's next steering boundary.

The first active source Reply with no existing external owner returns
`{"state":"running","accepted":true}` and owns polling for the shared final.
If a correlated external delivery already owns the conversation, or an earlier
source Reply became the owner, later active Replies return
`{"state":"accepted","accepted":true}` without `reply`. Admission order picks
the owner; secondary accepted records never claim a separate final. An idle source Reply returns the ordinary `pending`, `running`, or `completed`
state and polls for its shared final. It adds `accepted: true` only after the
runtime's `{ "accepted": true }` prompt acknowledgement is durable. A GET while
the in-process request is unresolved may report `running` but never `accepted`.
After restart, a dispatched request without persisted acknowledgement becomes
`attention`, not accepted. Queue acceptance is not evidence of processing or
successful action. Identical
IDs reuse their result, changed payloads conflict, and identical text with
separate IDs remain distinct native input. The public `mode: "reply"` payload
and fingerprint stay the same across active-to-idle retry. The receiver records
the selected internal operation before dispatch. A definite busy rejection
removes the unsent reservation so the same payload can be admitted again. A
crash or lost acknowledgement after dispatch yields `attention`, never a mode
change or automatic resend.

A reply-owning record uses its exact receipt to identify the initial native user
entry on the fenced session and selected branch. When opted into coalescing, it
waits for the final after the latest subsequent user entry, so later Dashboard
input shares that one final. Default idle deliveries retain exact-one-turn
behavior. No watcher or final-answer worker is added. Later aborts, forks,
runtime loss or queue removal do not turn queue acceptance into completion.

## Ownership and crash behavior

New deliveries carry `externalDeliveryId` separately in the bridge prompt. Native user text has no generated delivery prefix. The runtime writes a hidden SDK custom entry, `external-delivery-receipt`, with `{version: 1, deliveryId, userEntryId}`. It is neither a model message nor a Dashboard transcript item. Completion uses the referenced native user entry ID, not text matching, and requires that receipt and user on the persisted selected branch, ancestry from the pre-send leaf (normal leaf advancement is allowed), the same session/runtime, and a settled live runtime. A final reply must have native `stopReason: "stop"`, contain no tool calls, and be the sole final assistant message after that user entry. Thinking and intermediate tool-use commentary are excluded. An intervening user, removed anchor, replacement runtime/session, multiple final messages, aborted/length-limited output, or oversized output yields attention. Replies are bounded to 256 KiB UTF-8, never silently truncated.

Missing transcript data during index/bridge lag remains pending. Completed/attention results are frozen atomically in SQLite and cannot change when later messages arrive. Send intent is durable before dispatch, including the first orchestration hello. A genuine restart with an ambiguous dispatched send yields attention, never a speculative resend. An actively owned in-process dispatch is still running, not restart uncertainty.

This is not an arbitrary background-turn correlation protocol. Background activity producing additional user/final messages, compaction removing required evidence, and lost runtime/session evidence can require human attention. Do not replace an attention delivery with a new ID automatically: its original action may have executed. A live runtime that disappears without terminal evidence can remain pending until it reconnects or a terminal lifecycle observation arrives.

## Idle conversation retirement

POST `/conversations/settle` with `{commandId, conversationRef}`. The reference is resolved only within the requested active project; IDs are bounded to 256 characters. No arbitrary runtime ID or force flag is accepted. Results are `{state: "settled" | "absent" | "superseded", threadId?}` and are durably idempotent; reusing an ID for another reference conflicts. A completed close is never repeated against a subsequently reopened thread. A pending retry targeting a replaced runtime becomes superseded instead of stopping the new generation.

The caller must drain its own accepted messages/outgoing replies first. An active external delivery or runtime returns retryable `409 busy`. Dashboard command admission is fenced during retirement, and the runtime must acknowledge `shutdown` with `onlyIfIdle: true` after checking active and queued work. Errors, timeout, disconnected/unmanaged runtimes and older protocol implementations never fall through to forced process termination. An idle legacy runtime needs an explicit verified refresh before it supports this additive command; ordinary Dashboard deployment does not restart runtimes or hosts.

Old replies still resume the same indexed session without a setup prompt; successful input unsets the settled marker even if the session link has not caught up yet. Retirement does not delete history, memory or artifacts.

## Structural receipt boundary and compatibility

The default correlated bridge delivery accepts only an idle `prompt`. Opt-in source-fenced `steer` uses the separate queue-acceptance contract above; external `followUp` remains unsupported. Its explicit metadata disables slash/skill/template expansion independently of the text. `AsyncLocalStorage` carries dispatch provenance through the SDK input pipeline. The `message_end` hook captures the exact native user object; the subsequent `context` hook finds that same object in `SessionManager` and records its entry ID. There is no next-message, timestamp, or identical-text fallback. A real SDK fixture verifies this boundary, including identical intervening browser input and message-replacement hooks. If native identity is unavailable, a completed turn without its receipt requires attention, not guessed correlation or replay.

The SDK can buffer a new session until its first assistant entry; native user and receipt persistence follow that existing lifecycle. The outer SQLite intent remains durable before any dispatch. A crash between user and receipt persistence therefore cannot authorize replay. The initial delivery ID is stored atomically with the orchestration run (`initial_delivery_id`); it survives daemon restart without changing the initial text or model selection.

Runtimes must advertise `remote-control.external-delivery` version `1` or `2`; source-session-fenced replies require version `2`. An older continuation runtime returns retryable busy before admission; initial dispatch also checks support. There is no silent marker fallback for new work, nor a forced runtime refresh during deployment. Previously prepared intents, accepted marker-based deliveries, historical journals and frozen replies keep their original representation and correlation rules. Old `[[PI_EXTERNAL_DELIVERY:…]]` messages are not rewritten or visually relabeled.

## Attachments

At most four attachments, at most 10 MiB decoded total, canonical padded base64, and a bounded JSON body (14 MiB + 256 KiB) are accepted. Original names and MIME types are untrusted JSON-escaped metadata. Only server-derived digest directories and opaque filenames are used; no host path/URL input or execution is supported. Private directories/files are owner-only. Existing artifacts must match bytes and private ownership/mode; symlinks and nonregular files are rejected. Failed preparation removes only files created by that operation.

Raster files retain `.png`, `.jpg`, or `.webp` extensions. Images up to the existing 5 MiB native-image limit use the native path as well as a private manifest. Other files are evidence available to normal read/CLI tools, not fabricated extracted text. After an initial-image cache loss, the persisted manifest remains available. Accepted artifacts are retained because the session may refer to them on later turns; no public file-read route or automatic retention collector is added.
