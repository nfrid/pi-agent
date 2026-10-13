# Local telemetry

The dashboard home Diagnostics button and command-palette entry open `/diagnostics`.
It groups retained failures by source, operation, failure code and outcome, with
occurrence counts, first/last timestamps and up to five recent samples. Expected
outcomes are hidden by default. Successes contribute operation outcome counts,
but do not create issue groups. Counts cover retained observations, not lifetime
failure rates.

## Collection and privacy

The harness telemetry extension records tool completions, provider request
outcomes, delegate lifecycle failures/completions, and selected registration,
status-publication, bridge, background-delivery and cleanup failures. Bash command
failures and user cancellations are expected outcomes, not harness bugs. Coverage
is at these explicit boundaries, not every exception caught by Pi or a project.

The dashboard records authenticated finite HTTP/RPC outcomes, subscription
failures, browser errors, rendering failures and connection transitions. Browser
reports use fixed codes and an allowlisted error class where available. Raw error
messages, stacks, URLs and error objects never enter browser telemetry. Exactly
the standard ResizeObserver loop messages map to `resize-observer-loop`; other
browser errors remain `uncaught-error`. Browser requests require the existing
token, origin and protocol checks. The daemon accepts at most 120 browser reports
per minute.
During an outage the browser retains up to 20 observations in memory and retries
on another observation or an online/connection event. Closing the tab loses that
queue. Collection never reports its own transport failures.

Automatic records contain only operation/code/outcome, time, duration where
available, safe error class, version and opaque session/attempt IDs. They do not
contain prompts, transcripts, tool arguments/results, credentials, raw exception
messages, stack traces, URLs, local paths or provider payloads. Harness/server
versions contain the Pi version and Git revision captured by the process;
`PI_TELEMETRY_VERSION` can supply a release identifier. Browser samples contain
the dashboard bundle build ID.

Use `/report-quirk <description>` in Pi or the Diagnostics form for an explicit
report. Do not include secrets, prompts or tool output. Notes are capped at 1,000
UTF-8 bytes. Common credential patterns, URLs and home paths are redacted, but
redaction cannot detect every secret. Reports reference up to ten preceding
automatic records, restricted to the relevant session when one is known.
Expired context records disappear rather than being copied into a transcript
store. No automatic report, ticket, route edit, external sync or upload occurs.

## Storage and operation

The default store is `<Pi agent directory>/telemetry/events.sqlite`, respecting
`PI_CODING_AGENT_DIR`. Set `PI_TELEMETRY_DIR` to move or isolate it. The directory
is private to the user and database files use mode 0600. It is not tracked in Git.

The store retains at most 10,000 stored records for up to 30 days. Diagnostics
shows both stored row count and represented observation count. Writes and reads
prune older records. Diagnostics reports the actual earliest and latest retained
timestamps, or says none are available when the store is empty. SQLite
reuses freed pages; its database page limit is 32 MiB, with a bounded temporary
rollback journal during a write. Secure deletion clears deleted cells. Records
expire on the next read or write, not from a separate daemon.

Successful `http-200` records for `http..api.settings` and
`http..api.sessions..id.delegate.history` share hourly buckets by operation,
version and code. The stored occurrence count contributes fully to operation
outcome totals. Bucket expiration uses its first observation timestamp, so the
whole bucket expires together and retention may drop later observations by up to
one hour. Other successes, all failures, expected outcomes and quirks remain
individual records. Updating a bucket does not consume a record slot or evict a
separate record.

CLI recording does not require a dashboard daemon. Writes use short local
transactions with a 25 ms busy timeout. Unavailable, locked or corrupt storage
drops telemetry instead of failing the agent operation. The Diagnostics page
shows unavailable storage and manual reporting reports unsuccessful writes.
This is best-effort diagnostics, not an audit log.

Explicit dashboard `stateDir` options isolate telemetry below that state
directory unless `telemetryDir` or `PI_TELEMETRY_DIR` overrides it. Tests use
temporary stores; automatic harness writes are disabled under `NODE_ENV=test`
unless `PI_TELEMETRY_DIR` is explicit.

## Delegate settlement

Terminal durable history for the same run/job/workflow attempt takes precedence
over stale queued/running live status. A later continuation remains separate.
Status/rendering observers cannot turn successful execution into a lifecycle
failure or skip release of the session and launch locks. Publication errors enter
local telemetry. Existing transcript and workflow records are not rewritten.

After installing updated harness files and rebuilding workspace dependencies,
reload extensions in long-lived Pi sessions or start a new session to use the
new callbacks. Ordinary dashboard deployment does not restart managed runtime
or process hosts.
