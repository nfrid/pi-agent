# Dashboard communications hardening report

Phase 6 baseline: `67f5fa9`. The final commit is reported at the phase exit gate.

## Scenarios executed

| Scenario | Evidence | Observed recovery |
|---|---|---|
| Desktop Chromium on localhost | Full Playwright desktop project, including transcript geometry and virtualization contracts | The typed shell/session transport renders through the existing UI without a compatibility transport. |
| Hidden page suspended for more than 15 seconds, then resumed | `apps/dashboard-web/e2e/dashboard.spec.ts` reconnect scenario advances the browser clock by 16 seconds across `visibilitychange` | The application lifecycle owner replaces the shell subscription once, receives an authoritative snapshot, and returns to synchronized state. A short hidden interval remains connected in `connection-runtime.test.ts`. |
| Offline startup and network-interface return | Deterministic lifecycle event shims in `packages/dashboard-client/src/connection-runtime.test.ts` | No subscription opens while offline. An online event opens one shell feed. Offline invalidates pending opens and active subscriptions before reporting `offline`. |
| LAN-style endpoint selection and interrupted transport | Endpoint-probe tests in `http-client.test.ts`; authenticated stream interruption in the Playwright reconnect scenario and `trpc-feed.test.ts` | Candidate selection remains bounded. Subscription transport resumes with tracked IDs or receives an authoritative snapshot; tokens remain in headers rather than URLs. |
| Dashboard daemon generation change and restart | Generation replacement tests in `connection-runtime.test.ts` and production restart at the phase deployment gate | Shell authority replaces the old generation, cached session feeds are reacquired, and stale callbacks cannot roll state back. |
| Fast model-style burst | 10,000 keyed replacements in `live-feed.test.ts`; high-rate render notification tests in `store.test.ts` | Replay retention and gap metadata remain bounded. Replaceable updates coalesce in replay and browser notifications are limited to the latest useful value. |
| Multiple active runtimes/sessions | Independent shell/session and two-acquired-session tests in `connection-runtime.test.ts`; multi-runtime browser command targeting | Domain cursors and failures remain isolated; one session failure does not destroy a healthy shell or sibling session. |

## Failure injection evidence

| Injection | Recovery evidence |
|---|---|
| Disconnect before or during snapshot | Pending-open cancellation and abort-during-snapshot tests install no stale subscription and remove the server subscriber. |
| Disconnect during replay or after synchronization | tRPC tracked-resume integration and Playwright stream interruption recover without finite HTTP polling or stale rollback. |
| Foreign/future cursor | The feed records a `foreign` or `future` snapshot fallback and emits one authoritative snapshot. |
| Expired or coalesced replay | The feed records `expired` or `unavailable`; the conservative O(1) unavailable-through boundary forces a bounded snapshot rebase, after which later contiguous events replay normally. |
| Malformed event | Protocol parsers reject malformed data; the client does not advance accepted domain sequence or replace authoritative state. |
| Over-limit event or snapshot | Frame checks terminate the affected feed. Reconnect rebases from an authoritative snapshot rather than skipping the missing sequence. |
| Slow subscriber | Per-subscriber count and byte limits terminate only the slow subscriber and release its queue. |
| Authentication token removed or changed | Authentication/protocol errors close and invalidate every open domain, set global `blocked`, and cannot be cleared by stale callbacks. The token prompt reloads with changed input. |
| Foreground after long suspension | Browser automation proves one controlled replacement after the stale threshold and no replacement below it. |
| Server shutdown with active subscriptions | Feed shutdown rejects pending consumers and reports zero subscribers; production deployment verifies clean daemon restart. |

## Diagnostics and bounds

The authenticated typed tRPC query `liveDiagnostics` exposes shell metrics and a bounded set of session-feed metrics. It reports:

- generation, feed identity, current sequence, and oldest/newest retained cursors;
- retained replay count/bytes and configured limits;
- subscriber count and aggregate queued count/bytes with configured limits;
- subscription opens and tracked resume attempts;
- coalesced updates, queue-overflow terminations, and oversized terminations;
- largest serialized payload observed and configured maximum frame bytes;
- the conservative unavailable-through sequence boundary;
- fixed counters for initial, invalid, foreign, future, expired, unavailable, and replay-too-large snapshot fallbacks.

Current production defaults are 256 replay records, 4 MiB replay bytes, 128 queued items per subscriber, 4 MiB queued bytes per subscriber, and a 2 MiB feed payload limit. Server ping is 15 seconds; client inactivity reconnect is 5 minutes.

## Removed and absent compatibility paths

Production browser code contains no `/ws`, `/api/events`, `/api/snapshot`, or old tRPC bootstrap live path. Playwright fixtures fail if those transports are requested. Multipart runtime uploads and unrelated finite REST resources remain intentionally outside the live-transport cutover.

## Durable runtime mutation receipts

Runtime mutations require SQLite intents before effects; pending IDs also block
orchestration commands in the shared namespace before Git or filesystem work.
Managed launch insertion atomically checks the owning intent and never replaces
an existing runtime identity, including stopped history.

Bridge ACK results are not durable application state. Queue ACKs contain draft
text, and semantic action handlers can return arbitrary private output. The
first response (and same-process in-flight waiters) retains the original result;
new completed `runtime.command` receipts store only `{accepted:true}` (17 UTF-8
bytes). A later retry returns that success-only result without redispatch. Old
completed receipts are replayed unchanged, not rewritten. Receipt-shaped bridge
outputs fail closed. The browser queue/composer, runtime controls, command
palette, and transcript action callers await success but do not consume command
result data; queue state comes from runtime feeds. Lifecycle results such as the
replacement runtime ID remain available on replay. ACK followed by failed
receipt storage remains uncertain and is never automatically resent.

Restart captures the exact session file and supported configuration, validates
it before stopping, and reuses that file after recovery without depending on a
session-index snapshot. Missing resume evidence is an error, never a new session.
A launch with durable readiness proof can complete after response/storage loss;
without that proof it remains uncertain.

`stopped:true` for an external runtime means dashboard removal/tombstoning, not
OS termination. Shutdown rejection does not prevent that removal; a lost receipt
cannot be reconstructed as an external-stop success. Managed stop requires
provider termination evidence. The daemon's host client independently inspects
retained stopped history and verifies PID absence after the ACK, so an older
long-lived host's permissive ACK cannot produce a durable stopped marker.
Missing host history, an inaccessible PID, or PID reuse remains uncertain.
Production readiness additionally requires the managed bridge registration;
the host start protocol already waits for its Pi readiness probe. None of these
changes requires an ordinary deploy to restart the runtime or process host.

Fault/reopen evidence is in `runtime-intent-recovery.test.ts`; actual extension
ACK privacy is covered in `test/runtime-ack-privacy.test.ts`. These are isolated
checks, not a production rollout or browser deployment verification.

## Remaining limitations

- The O(1) unavailable-through boundary intentionally prefers extra snapshot rebases for cursors before the latest removed sequence over retaining exact coalesced-gap intervals.
- Session diagnostics return at most the newest 4,096 feed entries; inactive feed objects continue to use the existing timed sweep.
- Epoch-second and unusual timestamp formats fail open in transcript chronology rather than being guessed.
- Browser lifecycle automation models suspension and network interruption deterministically; later real-device validation should repeat the same diagnostics checks on Android/PWA and a lossy remote network.
- tRPC owns transport-level backoff and tracked reconnects; the application adds no second exponential retry loop.
