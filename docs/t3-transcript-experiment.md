# t3code-inspired transcript experiment

## Status

Branch: `experiment/t3-transcript-state`

Base: `e73f9b3` on `main`, including the verified fix for persisted/live fallback rows appearing after newer history.

This document is the durable handoff for implementation after context compaction.

## Objective

Make the existing dashboard transcript and transport behavior converge like t3code without importing Effect or replacing Pi's JSONL persistence.

The experiment should improve four things:

1. One client-owned transcript state transition path for snapshots, live events, and older pages.
2. Strict sequence and page-watermark handling without timestamp-based transport decisions.
3. Warm browser persistence of settled transcript snapshots.
4. Predictable scrolling with one explicit follow/manual mode and key-based prepend anchoring.

Settling, snoozing, inbox classification, and orchestration lifecycle changes are out of scope.

## Evidence and current failure modes

### Reported session

Session `01a01ea6-1b0a-7798-8f84-cd0c26e33aa0` was inspected directly.

- Its JSONL contained 118 valid entries with a correct `parentId` chain.
- Full `hydrateTranscript` output was physically chronological.
- The visible `1:22 PM -> 1:11 PM` jump came from live compatibility rows with IDs such as `timestamp:1787220706652` surviving after their persisted twins loaded.
- Commit `e73f9b3` fixes that specific prepend reconciliation bug.

### Structural risks that remain

`packages/dashboard-client/src/store.ts` still reconstructs transcript state through several separate paths:

- `hydrateSession`
- `applyEventEnvelope`
- `mergeLatestTranscript`
- `mergePrependedTranscript`
- `prependSessionHistoryPages`
- semantic persisted/live matching

`packages/dashboard-domain/src/transcript.ts` also mixes entity reduction with chronology inference:

- persisted hydration
- live lifecycle reduction
- fallback identities
- timestamp insertion
- tool ownership inference

`apps/dashboard-web/src/features/session/scroll.ts` has several independent scroll writers, timers, animation-frame retries, resize restoration, and implicit stickiness refs. These can fight the virtualizer and user intent.

## What to copy from t3code

Use the algorithms, not its Effect implementation.

### Snapshot and event state machine

References:

- `/Users/nfrid/code/t3code/packages/client-runtime/src/state/threads.ts`
- `/Users/nfrid/code/t3code/packages/client-runtime/src/state/threadReducer.ts`
- `/Users/nfrid/code/t3code/apps/server/src/ws.ts`

Semantics to copy:

- A snapshot replaces the loaded transcript window and establishes its sequence.
- Events at or below the accepted sequence are ignored.
- Snapshot fallback is normal recovery when a resume gap is invalid or too large.
- Live delivery attaches before snapshot or replay work begins.
- A caught-up marker distinguishes cached/synchronizing state from live state.
- Snapshot, event, and older-page application are serialized for one session.

The existing `BoundedFeed` already implements most server transport guarantees. Keep it unless a test proves a gap.

### Older-page watermarks

Reference: `makeEnvironmentThreadState` in t3code `threads.ts`.

Semantics to copy:

- Every older page carries the transcript sequence or runtime sequence at which it was read.
- Reject an older page behind the currently applied transcript sequence.
- Park a page ahead of live state until the subscription catches up.
- Invalidate an in-flight or parked page when a snapshot replacement, runtime epoch change, compaction reset, or branch rewrite changes history identity.
- Merge page collections by stable ID, preserving authoritative older-page order and newer entity data.

### Settled snapshot cache

References:

- `/Users/nfrid/code/t3code/apps/web/src/connection/storage.ts`
- `/Users/nfrid/code/t3code/packages/client-runtime/src/platform/persistence.ts`

Semantics to copy:

- Store schema-versioned transcript snapshots in IndexedDB.
- Include the accepted feed sequence, runtime epoch, and oldest loaded page cursor.
- Restore cached state immediately as `cached`, then resume from its sequence.
- Persist settled or dormant sessions, not every streaming delta.
- Debounce writes and keep one pending write per session.
- Decode failure or schema mismatch falls back to a cold load.
- Bound cache size and evict least-recently-used sessions.

### Scroll behavior

References:

- `/Users/nfrid/code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx`
- `/Users/nfrid/code/t3code/apps/web/src/components/chat/MessagesTimeline.logic.ts`

Semantics to copy:

- Explicit mode: `following` or `manual`.
- New rows and row-size changes maintain the bottom only in `following` mode.
- Upward wheel, touch, keyboard, scrollbar, outline, or minimap navigation enters `manual` mode immediately.
- Following rearms only within 40 pixels of the real content bottom.
- Older-page prepends preserve the first visible row key and its viewport offset.
- Disclosure expansion preserves its own anchor and temporarily disables bottom maintenance.
- Only the list/scroll controller writes scroll position. Remove competing hooks.

## Proposed architecture

### 1. Pure transcript session machine

Add a focused module under `packages/dashboard-client/src/session-transcript-state.ts`.

It should own:

```ts
interface SessionTranscriptState {
  projection: TranscriptProjection;
  sequence: number;
  sequenceKnown: boolean;
  generation: number;
  runtimeEpoch?: string;
  runtimeSeq: number;
  historyEpoch: number;
  coverage?: SessionHistoryCoverage;
  pendingOlderPage?: PendingOlderPage;
}
```

Pure operations:

```ts
installSnapshot(state, snapshot, ordering): TransitionResult
applyEvent(state, event, ordering): TransitionResult
mergeOlderPage(state, page): TransitionResult
markCaughtUp(state): TransitionResult
invalidateHistory(state, reason): TransitionResult
```

Rules:

- These functions are the only place allowed to combine transcript projection, sequence state, and history coverage.
- `DashboardLiveStore` remains the external store but delegates session transcript mutations to this module.
- React never receives raw envelopes or merges pages.
- Timestamps remain presentation metadata. They may place genuinely delayed live entities inside a snapshot only when no transport ordinal exists, but they must never override snapshot/page order.
- Exact IDs decide overlap. Semantic persisted/live reconciliation is an explicit normalization step at snapshot or page installation.

### 2. Protocol page watermark

Extend the authoritative session history metadata with an optional transcript watermark if the existing `cursor`, `runtimeEpoch`, and `runtimeSeq` tuple cannot prove the page cut.

Preferred minimal shape:

```ts
interface SessionHistory {
  // existing fields
  transcriptSequence?: number;
  runtimeEpoch?: string;
  runtimeSeq?: number;
}
```

Before changing protocol, verify whether current session feed `sequence` plus `runtimeSeq` already travels through `AuthoritativeSessionSnapshot`. Avoid duplicate fields if the cut is already exact.

### 3. IndexedDB cache

Add a small dashboard-client persistence adapter, not a generic framework.

Suggested API:

```ts
interface SessionTranscriptCache {
  load(sessionId: string): Promise<CachedSessionTranscript | undefined>;
  save(value: CachedSessionTranscript): Promise<void>;
  remove(sessionId: string): Promise<void>;
  prune(): Promise<void>;
}
```

Schema version starts at 1. Cache only JSON-safe projection fields and ordering metadata. Do not cache runtime control surfaces or pending interactions.

Integrate cache restore into session acquisition before the first HTTP snapshot. A cached sequence may be used for feed resume only when its server ID and protocol version match the connected server.

### 4. Scroll controller

Replace `useSessionScroll` internals with a reducer-like controller:

```ts
type FollowMode = 'following' | 'manual';
```

State transitions are driven by semantic actions:

- `SESSION_ENTERED`
- `USER_NAVIGATED_UP`
- `SCROLLED_NEAR_END`
- `JUMP_TO_LATEST`
- `ROWS_CHANGED`
- `OLDER_PAGE_WILL_PREPEND`
- `OLDER_PAGE_DID_PREPEND`
- `DISCLOSURE_WILL_RESIZE`
- `DISCLOSURE_DID_RESIZE`

Use a visible row key plus pixel offset for restoration. The scroll-height delta remains only as a non-virtual fallback.

## Implementation phases

### Phase A: characterization

Add regression tests before refactoring:

1. The reported session pattern: latest persisted page followed by retained old fallback message/tool IDs, then older persisted page.
2. Snapshot publication racing a deferred live event.
3. Older page behind current live sequence is rejected.
4. Older page ahead of current live sequence parks and later merges.
5. Runtime epoch replacement discards parked pages.
6. Prepend with overlapping tool IDs anchors the tool in older-page order while preserving live result/status.
7. User scroll intent during prepend cancels restoration.
8. Following does not rearm 41 pixels from bottom and does rearm at 40 pixels.

### Phase B: extract pure session state machine

- Move session projection and coverage mutation out of `DashboardLiveStore` into the new module.
- Keep public selectors and store API stable.
- Migrate one path at a time: snapshot, event, then prepend.
- Delete superseded helpers only after parity tests pass.

### Phase C: exact page ordering

- Confirm the authoritative snapshot cut available on the server.
- Add protocol watermark only if needed.
- Implement reject, park, catch-up merge, and history-epoch invalidation.
- Add server/client contract tests.

### Phase D: cache experiment

- Implement IndexedDB adapter with an in-memory test backend.
- Restore cached dormant sessions before network hydration.
- Persist after settlement/dormancy and on session release when safe.
- Add schema mismatch, corrupt payload, server mismatch, and eviction tests.

### Phase E: scroll experiment

- Replace the existing ref/timer collection with explicit follow mode.
- Make virtualizer/list anchoring the primary mechanism.
- Add focused hook/logic tests and desktop Playwright coverage.

### Phase F: browser verification

Use the reported session plus generated long-session fixtures.

Required browser checks:

- No timestamp regression while loading all older pages.
- No duplicate message or tool IDs after reload, reconnect, or pagination.
- Initial open lands at the latest row.
- Streaming keeps following until explicit upward intent.
- Reading history is never interrupted by new streaming chunks.
- Older-page prepend preserves the same visible row.
- Group expansion preserves the clicked row.
- Reload first paints from cache, then converges without jumping.

## Expected file scope

Likely changes:

- `packages/dashboard-client/src/store.ts`
- `packages/dashboard-client/src/store.test.ts`
- `packages/dashboard-client/src/session-transcript-state.ts`
- `packages/dashboard-client/src/session-transcript-state.test.ts`
- `packages/dashboard-client/src/session-transcript-cache.ts`
- `packages/dashboard-client/src/session-transcript-cache.test.ts`
- `packages/dashboard-protocol/src/dashboard-api.ts` or relevant session contracts
- `apps/dashboard-server/src/live-feeds.ts`
- `apps/dashboard-server/src/application/dashboard-application.ts`
- `apps/dashboard-web/src/features/session/scroll.ts`
- `apps/dashboard-web/src/features/session/scroll.test.ts`
- `apps/dashboard-web/src/features/session/history.ts`
- `apps/dashboard-web/src/entities/transcript/view/virtualized.tsx`
- `apps/dashboard-web/e2e/session-history.spec.ts`

Do not change `SessionIndex` or `BoundedFeed` without a failing invariant test.

## Acceptance criteria

1. One pure module owns transcript snapshot, live event, and older-page transitions.
2. No page merge can place an older timestamp after a newer persisted page unless the source transport order explicitly says it arrived there and no persisted twin exists.
3. Older-page races are rejected or parked using an exact sequence cut.
4. Dormant transcript cache restores safely and cannot survive schema/server mismatch.
5. Scroll follow mode has one owner and a 40-pixel rearm threshold.
6. The reported session renders monotonically after loading all history.
7. `pnpm run check` passes.
8. Relevant desktop Playwright tests pass on isolated ports.
9. Production is not deployed from the experiment branch unless explicitly requested.

## Stop conditions

Stop and report instead of widening scope if:

- Pi runtime events do not expose enough identity or ordering information to derive an exact page cut.
- The cache requires storing authentication tokens or runtime control state.
- A protocol change would break protocol-v2 compatibility without a safe optional rollout.
- The scroll virtualizer cannot expose a stable first-visible key; evaluate replacing the list implementation separately rather than layering more timers over it.
