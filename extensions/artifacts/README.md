# Exact artifacts

This extension stores allowlisted integration output as exact-byte SHA-256 CAS blobs under
`$PI_AGENT_DIR/artifacts/v1`. Handles are opaque and resolve only through the current
session manifest. Every recovery record is a custom `artifact:v1` session entry with a
base64 copy, so normal Pi JSONL export/import is the exact continuation format supported
for rebuilding missing CAS data; fork, tree navigation, and compaction use the same
embedded entries. HTML/share output is not an exact artifact continuation format and is
not supported for restoration. Custom entries are excluded from model context.

Integrations should import `artifactProducer` (or `putArtifact`) from this directory and
pass their `pi` and tool `ctx`, including a short safe `creationSource` identifier.
Metadata records its sanitized source, derived encoding, textual line count, and optional
validated item count. Producer and content classes are closed allowlists. They prevent
callers from explicitly labeling protected categories as allowed, but cannot semantically
prove that submitted bytes are unprotected. Each producer must still enforce that user
messages, approvals, decisions, credentials, and other protected bytes are never stored.
The web integration persists every response so `get_search_content` remains available
after session resume; small responses still remain inline because custom recovery entries
are model-invisible. The delegate integration stores only final assistant bytes omitted
from its bounded parent handoff. It excludes task text, context, approvals, decisions,
stderr, and transcripts. `revoke` writes an explicit tombstone and prevents future handle
resolution. Legacy `kind: purge` tombstones are read as revocations.

Publication, recovery, revocation, and GC use both an in-process queue and a private
filesystem lock at `.artifact-root.lock`, so separate Pi processes sharing this root are
serialized too. Lock owners record a random token, PID, and timestamp; acquisition uses
bounded backoff, only recovers valid owners whose PIDs are confirmed dead, and
never steals empty, malformed, or otherwise ambiguous locks. GC aborts without deletion when the lock
cannot be acquired. Pi 0.80.7 exposes neither a session deletion hook nor an
extension-owned export hook.
`collectGarbage()` therefore scans all persisted session JSONL files, aborts on malformed
state, and treats only manifests whose session header still exists as roots. A grace
period protects newly written data. Applications may invoke it periodically; the
extension does not guess a scheduling policy. GC may remove a CAS blob after all handles
are revoked or sessions are removed, but it does not alter session records.

`/artifact-revoke <handle>` is a model-invisible user command. It disables resolution and
prompts in TUI. This is not byte deletion: Pi's append-only session JSONL and standard
exports retain the earlier base64 recovery entry until upstream redaction/deletion
support exists. The extension never rewrites active session files and makes no claim of
irreversible deletion. `/artifact-gc` is also model-invisible and only runs when
explicitly invoked; there is no automatic scheduling.

`artifact_retrieve` is the sole model-facing tool. It supports metadata, exact base64
byte ranges, line ranges, head/tail, bounded literal and conservative linear-subset regex
search with bounded before/after line context, Markdown headings, and JSON Pointer/field
selection. Textual selectors reject binary artifacts. Line and heading excerpts preserve
LF, CRLF, and CR separators; head/tail respect UTF-8 boundaries. Results are selections,
never model-generated summaries, and explicitly distinguish source-selected,
selector-result, returned, selection-remaining, and source-remaining bytes under a hard
64 KiB serialized-result ceiling. (For JSON, the complete source is consumed while the
selector result is the rendered selected value.) Truncated match lists also report
remaining match counts. `bytes` mode remains
the exact base64 path for arbitrary data.

## Repeated-read snapshot references

The `--snapshot-reads` flag is **off by default**. When enabled, the public post-execution
`tool_result` hook observes successful text-only built-in reads. The built-in read always
runs and fresh returned text is always compared; filesystem I/O and stat data are never
cached. Exact results for a normalized path/offset/limit selection are stored as
`tool-output` artifacts. First and changed results retain their fresh text and append a
compact marker containing the selection snapshot ID and exact artifact handle. A verified
identical repeat is replaced by a compact visible reference containing the prior snapshot
ID and a concrete `artifact_retrieve` handle. Outcome details in the namespaced result
record `unchanged` and UTF-8-accurate `suppressedBytes` for diagnostics. This claim
applies only to that exact read selection, never implicitly to the whole file. Errors and
images are ignored, and missing or corrupt prior artifacts fail open with the fresh full
result.

This mode is disabled by default. Fresh reads always execute; only a verified identical
repeat for the same normalized selection is replaced by an exact artifact reference.

## Cache-aware context governor

The `--context-governor` flag is **off by default**. When enabled, a
post-execution handler marks only successful, text-only `web_search`, `fetch_content`, and
`get_search_content` results carrying their additive `details.artifact`, plus built-in
`read` results for which the snapshot handler has already established
`artifacts.readSnapshot:v1`. Marking starts with the result's first model-visible call and
never depends on token thresholds, preserving stable prompt prefixes. Old unmarked
history is never retrofitted. Delegate output is already bounded by its own extension and
is intentionally not governed; neither are todo output, arbitrary tools, retrievals,
errors, images, or protected human/decision messages.

Before every model request, the async context hook verifies both the session-scoped CAS
artifact and its SHA-256. It changes only the cloned request, not persisted history. Long
marked inline text gets a deterministic UTF-8-safe fixed-byte head/tail preview stating
its exact omitted/reclaimed byte count and an exact paged `artifact_retrieve` lines path.
The creation-time preview threshold is configurable with
`--context-governor-preview-bytes` (512–16384; default 2048) and is persisted in each
marker so later calls remain deterministic. Missing, revoked, changed, or corrupt data
fails open with the original inline result. `/context-governor` reports model-invisible
per-session retained/reclaimed, fail-open, and cumulative verification-time diagnostics.
When enabled, changed aggregate counters are also persisted after settled agent cycles as
`artifact-context-governor-metrics:v1` custom entries, without raw content.

This mode is disabled by default. Markers are additive metadata, so existing persisted
sessions remain valid.
