# Artifacts

Artifacts keep oversized tool output out of the context window. A producer hands over
bytes and gets back a handle plus whatever bounded preview it wants to show the model; the
model pulls exact slices back through `artifact_retrieve` only when it actually needs
them.

This directory is just the host registration. The library lives in
[`../shared/artifacts`](../shared/artifacts) because `web` and `delegate` produce
artifacts too, and an extension should not import a sibling extension.

## Storage

One agent owns its own artifacts. There is no sharing between sessions and no second
writer, so there is no locking, no content-addressed store, and no revocation — just plain
files:

```
$PI_AGENT_DIR/artifacts/v1/<sha256(sessionId)>/<handle>.json   metadata
$PI_AGENT_DIR/artifacts/v1/<sha256(sessionId)>/<handle>.bin    bytes
```

Handles are opaque and resolve only within the session that created them. Every put also
appends a model-invisible `artifact:v1` recovery entry carrying a base64 copy, which makes
ordinary Pi JSONL export/import the continuation format: a resumed, forked, or imported
session rebuilds its files from those entries on `session_start` and `session_tree`.
HTML/share output is not a continuation format.

Metadata is never trusted on the way back in. It is re-derived from the bytes and compared
— digest, size, encoding, line count, item count — so an edited session file yields no
artifact rather than a wrong one.

## Producing

Import `artifactProducer` from `shared/artifacts` and pass your `pi`, tool `ctx`, and a
short safe `creationSource` identifier such as `web.search`. Producer and content classes
are closed allowlists. They stop a caller from *labelling* protected data as storable but
cannot tell what bytes mean: every producer must still keep user messages, approvals,
decisions, and credentials out of artifacts.

`web` persists every response so `get_search_content` survives a session resume.
`delegate` stores every exact final assistant report that the compact parent-visible
handoff omits — never task text, context, stderr, or transcripts. A parent may deliberately
forward a bounded textual `delegate-output` artifact to a later child; availability is not
an instruction to retrieve it.

## Retrieving

`artifact_retrieve` is the only model-facing tool. Modes:

| mode       | selection                                                        |
| ---------- | ---------------------------------------------------------------- |
| `metadata` | size, encoding, line count — no content                          |
| `lines`    | `offset` (0-based line) and `limit`                              |
| `search`   | case-insensitive `query` with `beforeLines`/`afterLines` context |
| `json`     | RFC 6901 `pointer`                                               |
| `bytes`    | base64 slice by byte `offset`/`limit`, for binary artifacts      |

Results are selections, never summaries. Every response reports `totalBytes` and what is
left (`remainingBytes`, `remainingLines`, `totalMatches`) so the model can page instead of
guessing, and the whole serialized result stays under a hard 64 KiB ceiling. Textual modes
refuse binary artifacts and point at `bytes` instead.

## Garbage collection

`/artifact-gc` is model-invisible and only runs when invoked; nothing is scheduled. Pi
exposes no session-deletion hook, so it reconciles against the session files themselves and
deletes the directories of sessions that no longer exist. It is deliberately timid: an
unreadable session inventory aborts the sweep without deleting anything, because it cannot
be distinguished from a directory that is temporarily unavailable. Append-only session
JSONL is never rewritten, so GC removes stored copies, not recovery bytes.
