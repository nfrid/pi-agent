# Extensions Refactoring Plan

Status: draft for review
Scope: `extensions/` (all 14 extensions + `extensions/shared`)
Baseline: `npm run check` and `npm test` both pass (49 test files, 318 tests). Every phase below must keep that true.

## 1. Baseline facts

| Extension | src LOC | test LOC | Notes |
|---|---:|---:|---|
| delegate | 8,003 | 3,874 | 42% of all source; 2,304 LOC is `isolation/` |
| web | 3,394 | 1,609 | |
| artifacts | 2,510 | 1,825 | also acts as a library for web + delegate |
| tasks | 1,187 | 612 | |
| background-terminals | 1,078 | 467 | |
| usage | 874 | 628 | |
| system-prompt | 515 | 212 | |
| ask-user | 414 | 136 | |
| shared | 231 | 80 | only 4 modules, 8 import sites |
| input-highlighting | 203 | **0** | |
| activity-indicator | 189 | 186 | |
| continue | 146 | 175 | |
| footer | 138 | **0** | |
| notify-sound | 103 | 30 | |
| **Total** | **18,985** | **9,834** | |

`extensions/shared` exists but is vestigial: 231 LOC, imported from only 8 places. Meanwhile the same
concerns are reimplemented independently in 3–5 extensions each.

## 2. Findings

### A. Verbatim duplication (highest-confidence, lowest-risk wins)

**A1. Abort/timing helpers copied across four extensions.**
`abortError`, `waitFor`, and `withAbort` in `extensions/delegate/jobs.ts:73-126` and
`extensions/background-terminals/manager.ts:62-118` are the same functions with renamed locals.
The same `signal.reason instanceof Error ? … : new DOMException('Aborted','AbortError')` expression
also appears in `extensions/web/utils.ts:16-21`, `extensions/web/utils.ts:48-52`,
`extensions/shared/lifecycle-guard.ts:24-28`, and `extensions/usage/app-server.ts:14`.
Six independent copies of one 4-line invariant.

**A2. The whole async-job registry is instantiated twice by copy-paste.**
`DelegateJobManager` (`delegate/jobs.ts:140-327`) and `BackgroundManager`
(`background-terminals/manager.ts:167-393`) share, line for line in structure:
a `records: Map`, `counter`, `disposed`, per-record `observers` + `settled` promise + `resolveSettled`,
`onSettled`/`onChange` callbacks, `require(id)` with the identical `Known: ${…}` error message,
`runningCount`, `prune()` against a `MAX_SETTLED` bound, `peek(id, waitMs, signal)`, and `snapshot()`.
Only the payload (a delegated run vs. a child process) genuinely differs.

**A3. Two independent atomic-write implementations, one of them unsafe.**
`artifacts/storage-io.ts:41-57` does it correctly: unique temp name, `open('wx')`, `fsync`, `chmod`, `rename`.
`delegate/isolation/records.ts:45-50` uses a **fixed** `${target}.tmp` name with no fsync — two
concurrent writers collide and can leave a torn record. `delegate/session.ts:180-189` is a third,
partial copy (unique name, no fsync).

**A4. Two independent file-lock implementations with different semantics.**
`artifacts/storage-locking.ts` — async, `link()`-based atomic publish, bounded deadline with
exponential backoff, liveness via `process.kill(pid, 0)`, structured owner validation, stale recovery.
`delegate/isolation/locks.ts` — sync `openSync('wx')`, liveness by shelling out to `/bin/ps -o lstart=`,
2-attempt stale rename, no backoff, no deadline. They disagree on every robustness decision.

**A5. Widget lifecycle written three different ways.**
`delegate/index.ts:47-118` (100 lines: mount flag, 1s interval, 16ms coalescing timer, dispose
bookkeeping, try/catch on every `setWidget`), `background-terminals/index.ts:118-147` (count-cache +
`force` reassert on agent boundaries), `tasks/widget.ts:26-43` (recompute and re-set every call).
All three independently discovered "the TUI can drop a keyed widget" and solved it differently.

**A6. Status glyph/color mapping restated in six places.**
`delegate/jobs-tool.ts:47-50`, `delegate/widget.ts:40-50,137-140`, `delegate/render-utils.ts:271-308`,
`background-terminals/index.ts:403,427`, `tasks/model.ts:150-162`, `tasks/widget.ts:50-51` — all
mapping some state enum onto `✓ ✗ ■ ● ○` and `success/error/warning/muted/dim`.

**A7. Registration boilerplate ×11.** `const registered = new WeakSet<object>()` plus the
`if (registered.has(pi)) return;` guard is pasted into all 11 extension entry points.

**A8. `new Text(x, 0, 0)` appears 74 times** in non-test code, almost always to wrap one themed string.

### B. Architecture problems

**B1. `artifacts` is simultaneously an extension and a shared library.**
`artifacts/index.ts` has a default export registered with the host *and* ~30 named exports consumed by
`web/storage.ts`, `web/result-support.ts`, `delegate/tool-result.ts`, `delegate/isolation-lifecycle.ts`,
`delegate/types.ts`. Consumers reach across an extension boundary into a sibling's public surface, and
the library half works whether or not the extension half was ever registered. That coupling is
undeclared and unenforced — nothing fails loudly if load order or registration changes.

**B2. Entry points are god-files mixing five concerns.**
`background-terminals/index.ts` is 474 lines holding the schema, param validation, widget lifecycle,
completion delivery, the tool `execute`, `renderCall`, `renderResult`, a message renderer, and the
`/ps` command. `delegate/index.ts` (269) and `artifacts/index.ts` (200) do the same. There is no
convention for what an `index.ts` may contain, so each extension invented one.

**B3. `delegate` is a monolith at 42% of the codebase.**
It contains at least four separable subsystems: job management, model routing/config, the render layer
(`render.ts` → `render-call.ts` + `render-result.ts` + `render-utils.ts`, 927 LOC across a 2-line
barrel), and the isolation/patch broker (2,304 LOC). The render split in particular is arbitrary:
`render-utils.ts` exports 25+ symbols consumed by `render-result.ts`, so it is a second implementation
file, not a utility module.

**B4. No shared contract for the extension lifecycle.**
`createLifecycleGuard` in `shared/` is exactly the right idea — and only `web` and
`artifacts/snapshot-reads.ts` use it. `delegate`, `tasks`, `background-terminals`, and `usage` each
hand-roll `session_start`/`session_tree`/`session_shutdown` teardown with their own module-scoped
mutable state (`delegate/index.ts:32-43` holds nine `let` bindings). Teardown correctness is
re-derived per extension, which is exactly where leaks and stale-generation bugs live.

### C. Over-engineering

**C1. `artifacts` (2,510 LOC) is built to a durability standard the use case does not need.**
A content-addressed blob store with sha256 verification, cross-process filesystem root locking with
stale-owner recovery, per-session manifests, double-hash `verified-resolution`, GC, and revocation —
for caching web results and delegate output in a single-user local agent config.

**C2. The context governor is dead weight in its current form.**
`artifacts/context-governor.ts` (312 LOC + 268 test LOC) is gated behind `CONTEXT_GOVERNOR_FLAG`,
`default: false`. It carries a metrics-counter subsystem (`GovernorCounters`, `verificationMs`
timing, dedup-by-identity `appendEntry` persistence, a `/context-governor` diagnostics command) for a
feature nobody has turned on.

**C3. `artifacts/retrieval-modes.ts` ships nine retrieval modes** (`metadata`, `bytes`, `lines`,
`head`, `tail`, `literal`, `regex`, `heading`, `json`) with per-mode offset/limit/context-line
handling. Most are one-line variations on a byte range.

**C4. The delegate isolation broker (2,304 LOC) is macOS-only by construction.**
`IsolationRecord.backend` validates to exactly `'macos-sandbox-exec'`
(`delegate/isolation/records.ts:141`). It implements git worktree provisioning, sandbox profile
generation, credential copy/scrub, dependency linking with realpath validation, patch capture →
hash → validate → apply/discard, a lock manager, and a `/delegate-patch` command. This is the single
largest maintenance liability in the repo and it has one supported platform.

### D. Robustness gaps

- **D1.** `delegate/isolation/records.ts:45` fixed-name temp file (see A3) — a real concurrency bug, not just a smell.
- **D2.** The delegate isolation layer is almost entirely **synchronous fs** (`readFileSync`, `writeFileSync`, `execFileSync`) on the event loop, while `artifacts` is fully async. Both run in the same process.
- **D3.** `footer` (138 LOC) and `input-highlighting` (203 LOC) have **zero tests**; both do non-trivial width/ANSI math.
- **D4.** Silent `catch {}` around every `setWidget` call in three extensions means a persistent UI failure is indistinguishable from a transient one.

## 3. Target architecture

Promote `extensions/shared` from a scrap drawer to the load-bearing platform layer, and make
cross-extension dependencies explicit instead of ambient.

```
extensions/shared/
  runtime/
    extension.ts       # defineExtension(): registration guard (A7) + lifecycle wiring (B4)
    lifecycle.ts       # existing lifecycle-guard, made the mandatory path
    async.ts           # abortError, throwIfAborted, waitFor, withAbort, abortableDelay (A1)
    registry.ts        # generic AsyncJobRegistry<TPayload, TState> (A2)
  fs/
    atomic.ts          # atomicWriteFile / atomicWriteJson — one correct impl (A3)
    lock.ts            # withFileLock — one impl, artifacts' semantics (A4)
    paths.ts           # agent/state dir resolution, currently duplicated in web/utils + isolation/records
  ui/
    widget.ts          # createManagedWidget(): mount/remount/coalesce/teardown (A5)
    status.ts          # STATUS_GLYPHS + stateColor, one table (A6)
    text.ts            # line()/themed helpers replacing `new Text(x, 0, 0)` (A8)
  hash.ts              # sha256 helpers (currently 8 call sites of createHash)
```

Two rules to keep it from rotting back:

1. **No extension imports another extension.** Anything two extensions need moves to `shared/`.
   This retires `web → artifacts` and `delegate → artifacts` (B1).
2. **`index.ts` is registration only.** Schemas, tool bodies, renderers, and commands live in
   sibling modules. `tasks/index.ts` (49 lines) is already the model; `background-terminals/index.ts`
   (474) is the anti-model.

## 4. Phased plan

Phases 1–3 are pure consolidation and should land regardless. Phases 4–6 need the scope decisions in §5.

### Phase 1 — Shared runtime primitives (low risk, high leverage)

1. `shared/runtime/async.ts`: single `abortError`/`throwIfAborted`/`waitFor`/`withAbort`/`abortableDelay`.
   Migrate `delegate/jobs.ts`, `background-terminals/manager.ts`, `web/utils.ts`,
   `usage/app-server.ts`, `shared/lifecycle-guard.ts`. Port the existing tests as the shared suite.
2. `shared/fs/atomic.ts`: promote `artifacts/storage-io.ts:41-57` verbatim as the one implementation.
   Migrate `delegate/isolation/records.ts` and `delegate/session.ts` onto it — **this fixes D1.**
   Add a concurrent-writer test.
3. `shared/hash.ts`: consolidate the eight `createHash('sha256')` sites.

*Verification:* `npm run check && npm test`. Behaviour-preserving except the records.ts fix, which
needs a new test.

### Phase 2 — Shared UI layer

4. `shared/ui/status.ts`: one glyph/color table; migrate the six sites in A6.
5. `shared/ui/widget.ts`: `createManagedWidget({ key, render, refreshMs })` owning mount state,
   render coalescing, agent-boundary re-assert, and teardown. Migrate `delegate/index.ts` (deletes
   ~90 lines), `background-terminals/index.ts`, `tasks/widget.ts`. Replace the blind `catch {}` with
   one logged-once-per-session failure path (D4).
6. `shared/ui/text.ts`: helper for the 74 `new Text(x, 0, 0)` sites; apply opportunistically, not as a
   mass rewrite.

*Verification:* existing `delegate/widget.test.ts` and `background-terminals/index.test.ts` must pass
unchanged. Add a widget-lifecycle test at the shared level.

### Phase 3 — Extension host contract

7. `shared/runtime/extension.ts` exporting `defineExtension({ name, setup })`, folding in the A7
   guard and mandatory lifecycle registration. Convert all 11 entry points.
8. Split `background-terminals/index.ts` (474 → target <80) into `schema.ts`, `tool.ts`,
   `renderers.ts`, `commands.ts`, `index.ts`. Same treatment for `delegate/index.ts` and
   `artifacts/index.ts`.
9. Add tests for `footer` and `input-highlighting` (D3) — width math and ANSI highlighting are
   pure functions and cheap to cover.

### Phase 4 — Unify the job registry

10. `shared/runtime/registry.ts`: `AsyncJobRegistry<TPayload, TState>` carrying records/counter/
    observers/settled/prune/peek/require/snapshot/dispose. `DelegateJobManager` and
    `BackgroundManager` become thin adapters supplying start semantics, state derivation, and
    teardown (`terminate` vs `abort`).

Larger blast radius than 1–3; do it only after Phase 1 has already unified their helper layer, which
makes the remaining diff small and reviewable. `delegate/jobs.test.ts` and
`background-terminals/manager.test.ts` are the safety net.

### Phase 5 — Decouple `artifacts` (B1)

11. Move the producer/consumer library half out of the extension into `shared/artifacts/`, leaving
    `extensions/artifacts/index.ts` as registration + commands + the retrieve tool only.
12. Repoint `web/storage.ts`, `web/result-support.ts`, `delegate/tool-result.ts`,
    `delegate/isolation-lifecycle.ts`, `delegate/types.ts` at `shared/artifacts`.

### Phase 6 — Scope reduction (needs decisions in §5)

13. Delete or extract the context governor (C2).
14. Collapse retrieval modes (C3) to `bytes` + `lines` + `heading`/`literal` (the last two already
    delegate to `shared/text-selection.ts`), or keep all nine if they are actually exercised.
15. Decide the fate of the isolation broker (C4).
16. Consolidate the two lock implementations (A4) onto the `artifacts` semantics — sequenced last
    because it depends on 15.

## 5. Decisions needed before Phase 6

These change the shape of the work and are yours to call:

- **Isolation broker (2,304 LOC, macOS-only).** Options: (a) keep and pay the maintenance cost,
  (b) extract to a separate opt-in extension so `delegate` drops to ~5,700 LOC, (c) reduce to
  worktree provisioning + manual patch review and drop sandbox profiles, credential scrubbing, and
  dependency linking. **Recommendation: (b)** — it preserves the capability, makes the cost visible,
  and lets `delegate` be reviewed as an orchestrator rather than a sandbox runtime.
- **Context governor.** Default-off, unused, 580 LOC with tests. **Recommendation: delete**; it is
  recoverable from git history if the idea returns.
- **Artifacts durability tier (C1).** Is cross-process concurrent access a real requirement for a
  single-user local config? If not, the CAS + root-locking layer can shrink substantially. If yes,
  it stays and Phase 6.16 becomes the priority instead.

## 6. Sequencing and safety

- Phases 1–3 are independent of the §5 decisions and can start immediately.
- One phase per branch; each lands green on `npm run check && npm test`.
- Refactor steps must be behaviour-preserving. The three exceptions are called out explicitly and
  each ships with a new test: D1 (fixed temp name), D4 (widget failure logging), D3 (new coverage).
- Existing tests are the contract. Where a phase deletes a test file, the assertions move up to the
  shared suite rather than disappearing.

## 7. Expected outcome

- ~1,200–1,800 LOC removed by Phases 1–4 (duplication only, no capability loss).
- A further ~2,900 LOC moved out of the hot path if §5 lands as recommended
  (isolation extracted, governor deleted).
- One implementation each of: abort handling, atomic write, file locking, job registry, widget
  lifecycle, status rendering.
- `delegate` reduced from 42% of the codebase to roughly a quarter, and reviewable as one subsystem.
- No extension importing another extension.
