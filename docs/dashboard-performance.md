# Dashboard performance

## Measured optimization pass

Baseline: `28a6761e`. Measurements were taken on 2026-09-07 on an Apple M4 Pro,
Node 25.8.0, Bun 1.4.0. Both checkouts were isolated from production. The same
synthetic fixtures and benchmark scripts ran against the baseline and candidate;
fixture creation and builds were outside the timed regions. These are local
component measurements, not production endpoint latency or a dashboard-wide
speedup claim.

Node benchmarks use seven measured samples after warmup. Cache and metadata
samples are batches; their reported latency is the batch mean per operation.
With seven samples, the reported p95 is effectively the slowest sample, not a
reliable estimate of a production tail. Host load and OS file caches affect the
results; compare repeated runs on the same machine rather than adding fixed
millisecond assertions to CI.

| Workload | Baseline median | Candidate median |
| --- | ---: | ---: |
| 1,000 feed events, 24 KB each, one subscriber | 7.28 ms | 3.92 ms |
| Same feed workload, eight subscribers | 29.44 ms | 5.12 ms |
| Eight subscribers, explicit queue bursts of 32 events | 61.77 ms | 4.68 ms |
| Targeted metadata delta, 1,000 sessions | 0.257 ms/call | 0.034 ms/call |
| Targeted metadata delta, 5,000 sessions | 1.334 ms/call | 0.035 ms/call |
| Decode cached projection, 1,000 items | 3.52 ms/decode | 0.095 ms/decode |
| Decode cached projection, 10,000 items | 38.00 ms/decode | 0.94 ms/decode |
| Scan a JSONL line crossing 64 KiB | 0.27 ms | 0.27 ms |
| Scan a 1 MiB JSONL line | 2.53 ms | 1.92 ms |
| Scan an 8 MiB JSONL line | 61.01 ms | 13.47 ms |
| Scan a nearly 32 MiB JSONL line | 1,078.10 ms | 45.69 ms |
| Latest page, 10,000-entry indexed session | 8.33 ms | 3.22 ms |
| Older page, same session | 7.90 ms | 3.72 ms |
| Selected-branch page, same session | 11.24 ms | 5.49 ms |
| Unchanged full rebuild, same session | 49.31 ms | 45.66 ms |

The feed benchmark measures in-process publication and subscriber delivery,
including a separate explicit queue-burst workload, not HTTP/SSE encoding or
network transfer. The metadata fixture has one live runtime
and no registered projects; it demonstrates catalogue-size scaling, not project
resolver or multi-runtime scalability. The cache fixture exercises projection
validation without multipage coverage reconstruction. Scanner results include
parsing, redaction and hashing, not just buffering. Repeated history reads use
an unchanged index and the same requested leaf, exercising topology reuse.

### Changes retained

- Feed queues retain payload byte counts computed at publication/snapshot time.
  Fanout and dequeue no longer stringify the payload for accounting. Replay,
  snapshot handoff, frame limits, slow-subscriber termination and sequences stay
  unchanged; this does not introduce live-event coalescing.
- A targeted metadata update uses a catalogue-filtered indexed lookup and updates
  its privately owned publication baseline in place. Catalogue ordering and
  auxiliary-session visibility remain unchanged.
- Cached transcript validation uses set membership and validates each own item
  once, retaining the persisted cache acceptance rules.
- The scanner searches each incoming chunk once and collects split-line
  fragments, concatenating only when a line completes. Physical offsets, hashes,
  UTF-8 behavior, partial lines and existing limits remain authoritative.
- Branch topology is retained for only the latest requested leaf per immutable
  history-index object. Replacing the index invalidates it; responses receive
  copies so callers cannot mutate later responses.
- Closed native tool disclosures do not mount their inspectors. Opening shows
  the current tool data; live changes remain visible while open.
- Settings and usage analytics load on demand. Their loading statuses remain
  within the existing surfaces. The always-visible usage sparkline no longer
  imports the analytics panel.

The initial production JS entry decreased from 1,245,752 to 1,214,754 bytes;
locally computed gzip sizes decreased from 372,161 to 362,708 bytes (about 2.5%).
This is a modest startup-payload improvement, not proof of faster startup. It
moves utility code to separately requested chunks; the composer was already lazy.
Gzip sizes are calculated locally, not evidence of deployed HTTP compression.

## Production-browser measurements

Headless desktop Chromium 151.0.7922.34, 1280×900, localhost, no CPU/network
throttling. Each scenario uses five fresh-context samples after one warmup.
Baseline and candidate ran sequentially with the same harness and fixed build
ID. API/SSE data is fixture-driven, unknown API calls are blocked and reported,
service workers are disabled, and timed runs have tracing disabled.

| Driver-observed workload | Baseline median | Candidate median |
| --- | ---: | ---: |
| Cold home until heading is visible | 122.9 ms | 127.3 ms |
| Cold direct session until heading/transcript are visible | 139.7 ms | 151.0 ms |
| 1,000-entry transcript scroll and outline jump | 268.7 ms | 269.1 ms |
| Expand 20-tool group, then open one inspector | 46.7 ms | 74.8 ms |
| DOM nodes after that tool interaction | 625 | 302 |

These durations include Playwright actionability/polling and are not INP, paint
latency, or isolated React render time. The sample is too small to establish a
startup regression or improvement. The 1,000-entry history interaction was
essentially unchanged. Deferred inspection halves this fixture's DOM but moves
work to disclosure: opening one inspector adds about 28 ms to the tested
interaction. This memory/DOM versus disclosure-latency tradeoff is explicit; it
is not described as a faster interaction. No nested virtualization or streaming
projection redesign was justified by this workload. Twenty tools is a bounded
comparison, not a stress test of huge groups.

Initial JS transfer size recorded by Chromium decreased from 372,442 to 362,982
bytes (including transfer overhead). The direct-session measurement ends before
the lazy composer has necessarily loaded, so it is shell readiness rather than
time to an editable composer. Median action-window long-task counts were zero;
one candidate direct-session sample reported one 50 ms long task. This does not
prove smoothness under streaming, throttling or on a real mobile device.

```sh
PI_DASHBOARD_PERF_REPORT=/tmp/dashboard-browser-report.json \\
  bun run --filter @pi-dashboard/web test:e2e:performance

# Diagnostic run: retains successful and failed traces, not comparable timing.
bun run --filter @pi-dashboard/web test:e2e:performance:diagnostic
```

The dedicated runner builds into a temporary directory, starts strict-port Vite
preview, and removes the temporary bundle afterward. It neither rebuilds the
normal web `dist/` nor starts a daemon. Defaults are ports 43274/43273; use
`PI_DASHBOARD_PERF_WEB_PORT` and `PI_DASHBOARD_PERF_API_PORT` to select unused
ports. Never stop an unfamiliar port owner. For a baseline comparison, copy the
same performance spec, fixture helper, performance config and runner to the
baseline checkout, then run its existing `test:e2e` script with
`-- --config playwright.performance.config.ts`.

## Reproduce Node measurements

Use an isolated checkout. Do not rebuild or remove production `dist/` artifacts
for profiling; follow [dashboard-deployment.md](dashboard-deployment.md).

```sh
bun run workspace:build
node scripts/dashboard-feed-bench.mjs
node scripts/dashboard-metadata-bench.mjs
node scripts/dashboard-cache-bench.mjs
node scripts/dashboard-scanner-bench.mjs
node scripts/dashboard-history-bench.mjs
```

Scripts import built production modules, use temporary synthetic data, and close
resources afterward. They do not read live session files, open production
sockets, or alter the metadata database used by the dashboard. For a baseline
comparison, copy the same benchmark scripts into a checkout of the baseline,
build that checkout's production modules, and run sequentially. Avoid parallel
builds, tests and benchmarks during the comparison.

For a CPU flame chart, use Node's built-in profiler and open the result in
Chrome DevTools' JavaScript Profiler:

```sh
node --cpu-prof --cpu-prof-dir=/tmp \
  --cpu-prof-name=dashboard-history.cpuprofile \
  scripts/dashboard-history-bench.mjs
```

Allocation sampling is also available without production instrumentation:

```sh
node --heap-prof --heap-prof-dir=/tmp scripts/dashboard-history-bench.mjs
```

The initial CPU profile identified branch-topology construction as the largest
non-idle sampled function in the history workload. Read-byte diagnostics already
proved history I/O bounded: both versions read at most 167,040 bytes per tested
page from a 6,521,802-byte session. This supported topology reuse rather than
another file-content cache.

## Verification and rollout status

- Follow-up scoped Vitest run: all 965 tests pass across server, client and web.
  The initial watchdog failure (`spawnSync lsof ENOENT`) was caused by the
  background runner's `PATH` omitting `/usr/sbin`, where macOS installs `lsof`.
  The test now signals its directly spawned Node child instead of rediscovering
  its PID with `lsof`. A failed `ps` invocation can no longer masquerade as a
  terminated descendant. All 13 process-host tests and the complete dashboard
  suite pass under the original restricted `PATH`; no runner or production
  runtime configuration was changed.
- Server, client and web typechecks pass. Biome checks pass for all 33 changed
  code/benchmark/configuration files. This repository's Biome configuration
  ignores Markdown; documentation was reviewed separately.
- Eight focused desktop/mobile Playwright regressions pass, covering native
  disclosure, lazy utility surfaces, virtualization, outline behavior and
  reconnect. The separate production-performance suite passes on both baseline
  and candidate. Default Playwright excludes the performance suite.
- An independent bounded review found no production correctness regression in
  the changed feed, index, cache and UI boundaries.
- Production services and production build artifacts were not changed. A later
  rollout needs the full dashboard build/restart procedure because server and
  shared client code changed; do not restart the runtime or process hosts.

## Deliberately unchanged

- Full rebuilds still scan unchanged files. Skipping scans or indexing only
  appends requires stronger file-version proofs and careful reuse of staged
  metadata side effects. The measured rebuild workload does not justify
  weakening rewrite, truncation or watcher-race handling.
- No general repository revision cache, new SQL indexes, worker pool or metrics
  service was added. Measure real project/runtimes and query plans before adding
  these maintenance costs.
- Transcript projection, streaming Markdown and expanded-group virtualization
  were not redesigned. Existing notification batching, memoization and outer
  virtualization remain. A large-history browser workload alone does not prove
  high-rate streaming or arbitrarily large expanded groups are smooth.
- Browser benchmark fixtures do not measure daemon-to-paint SSE latency, PWA
  service-worker behavior, sustained heap retention, real-device input latency,
  lossy networks, or production backpressure. These remain separate follow-up
  profiling workloads, not claims of this pass.

For a later transport stress run, reuse authenticated `liveDiagnostics` for
queued/replay bytes, subscribers, overflow/oversize counters and snapshot
fallback reasons. Pair those counters with event-loop delay/utilization and
end-to-end timestamps in an isolated daemon; do not add another reconnect loop
or relax delivery bounds to improve benchmark numbers.
