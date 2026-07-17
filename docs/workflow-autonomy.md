# Transactional autonomy

Transactional autonomy is enabled through the `standard` profile in `canary` mode on this macOS installation. It enforces repository-aware inspect/edit leases and effect-contained shell execution while recording aggregate local telemetry. Local Git, delivery, destructive actions, automatic delegate patch application, and writable todo scheduling remain independent capabilities and are not granted by a profile.

## Capability broker

The broker separates a user-owned authority ceiling from agent-selected task leases. Trusted workspace and repository roots define the ceiling. Each Git repository inside a metadata workspace remains an independent authority unit, so authority on the metadata repository does not authorize nested product repositories. Repository discovery uses workspace configuration and recursive Git-root scanning; operations that could cross a nested repository fail closed when discovery is incomplete or repository-root inspect authority is absent.

A session starts with `inspect` on the current repository. `autonomy_propose` requests the smallest additional inspect/edit lease required by the user request. In `canary` mode, the `standard` profile automatically approves those low-impact leases when every repository remains inside `autonomy.trustedRoots` and every capability is listed in `autonomy.autoApprove`. Repositories outside the trusted ceiling and local-Git, delivery, or destructive authority remain interactive and explicit.

Configure defaults under `autonomy` in `settings.json`, or use:

- `--autonomy-mode observe|canary|enforce`
- `--no-autonomy-enforce` for an observe-only session
- `--autonomy-profile cautious|standard|high`
- `--autonomy-capabilities inspect,edit`
- `--autonomy-scope path-a,path-b`

`/autonomy-envelope` shows or explicitly replaces the repository-aware session envelope. Persisted v1 envelopes are normalized to the current schema. In `enforce` mode every authority expansion requires confirmation; `observe` records policy decisions without blocking; `canary` enforces boundaries while automatically approving only configured trusted inspect/edit leases.

Controlled read/edit/write, navigation, artifacts, todo operations, delegates, and `sandbox_shell` are policy-aware. Delegation and transactional shell modes require repository-root inspect authority because their snapshots may contain the full repository; final writes remain constrained by edit paths. Built-in Bash is blocked under enforcement, while Bash syntax remains available through `sandbox_shell`.

Profiles affect confirmation behavior and scheduler defaults only. Hard defaults never infer local Git, delivery, destructive action, or automatic delegate patch application.

## Effect-contained parent shell

`sandbox_shell` treats Bash as an execution mechanism rather than a write capability. Classification selects an expected profile, while the macOS sandbox and transaction checks enforce actual effects:

- `inspect` runs in the current checkout with repository writes, network, process signaling, host-data reads, inherited secrets, and Git metadata writes denied;
- `validate` snapshots HEAD plus staged, unstaged, and untracked state into a private transaction, creates APFS copy-on-write dependency clones, permits build/cache writes there, and discards command changes after reporting them;
- `edit` uses the same transaction and applies only successful non-deleting changes inside declared edit scope after parent-drift and `git apply --check` validation.

Out-of-scope paths, deletions or type replacements, parent drift, command failure, escaping symlinks or dependencies, incomplete nested-repository discovery, and unsupported sandboxing leave the parent unchanged. An external edit racing a checked apply is reported as `conflicted` and is never automatically rolled back over external work. Network and Git metadata mutation remain unavailable. Classification may choose or explain a profile, but it never grants authority and is not a security boundary.

## Delegate route selection

Delegation is catalog-only. Every fresh task supplies one exact `route` key from the user-owned catalog. A continuation reuses its persisted route when omitted and may switch only by supplying another complete route key. Parallel tasks may share a top-level route or select routes independently. The compact routing table is injected into the stable parent system prompt when delegation is available.

Each `delegate.modelCatalog` entry represents one provider/model/thinking route with a stable key, positive finite `relativeCost` and `relativeIntelligence`, and optional provider and description fields. `delegate.maxRelativeCost` is the hard route ceiling. Relative cost controls admission and scheduler compute accounting. Relative intelligence is role-neutral selection metadata and grants no capability. Unknown and over-cost routes fail rather than silently substituting.

```json
{
  "delegate": {
    "maxRelativeCost": 21,
    "modelCatalog": {
      "<stable-route-key>": {
        "provider": "<provider-id>",
        "model": "<model-id>",
        "thinking": "medium",
        "relativeCost": 1.5,
        "relativeIntelligence": 2.5,
        "description": "<optional strengths and limitations>"
      }
    }
  }
}
```

## Read-only delegates

Read-only delegates expose `inspect_shell` on supported macOS hosts. Commands run in a nested `sandbox-exec` boundary with filesystem writes, network, process signaling, and inherited secrets denied. The child process receives a minimal environment and can contact the selected model provider, but its tools cannot access credentials. Provider authentication is copied into a mode-0600 private startup directory and scrubbed on exit; stale crash residue is scrubbed on the next delegate-extension startup.

If a read-only OS sandbox is unavailable, Bash is removed and the child receives controlled `read`, `grep`, `find`, and `ls` tools only. Commands requiring generated files or repository-local caches should use an isolated writable worktree or controlled validation rather than weakening the read boundary.

## Isolated writable delegates

`delegate` is writable only when `allowWrites: true` and at least one existing `scope` path are supplied. It requires a clean Git repository, macOS `sandbox-exec`, a detached locked worktree, and a profile permitting writes only to declared worktree paths and private state. Writable children receive controlled read/edit/write tools and no Bash.

A continuation reuses its original worktree, nested working directory, and repository-relative scope, but must repeat `allowWrites: true` to edit. The active capability envelope revalidates stored scope before resumed edits. Parallel writable tasks require non-overlapping scopes. If writable isolation cannot be established, execution falls back to enforceable read-only mode and reports the reason.

`dependencies: auto` may link unchanged repository dependencies through a read-only filesystem boundary. Linked dependencies are detached before validation, and frozen offline installation with lifecycle scripts disabled provisions isolated dependencies when a supported lockfile exists. `dependencies: isolated` never reuses parent dependencies.

After each isolated run, Pi captures and hashes the cumulative binary patch against the original base, validates scope/path/symlink safety, and retains the worktree in user state outside the target repository. It never applies automatically.

## Patch lifecycle

Commands:

```text
/delegate-patch list
/delegate-patch <id-or-continuation> show
/delegate-patch <id-or-continuation> diff
/delegate-patch <id-or-continuation> validate <package-script>
/delegate-patch <id-or-continuation> validate-command <executable> [args...]
/delegate-patch <id-or-continuation> apply
/delegate-patch <id-or-continuation> discard
```

Validation binds either the exact package-script definition or exact executable argv, uses a minimal environment, denies network and process signaling, and fails if the patch changes. Apply requires a successful child, passed validation, a matching patch hash, an unchanged clean parent, locks, and `git apply --check`. A post-apply concurrent external edit is marked `conflicted`; Pi refuses automatic rollback rather than overwrite external work.

Run-owner identity prevents concurrent lifecycle operations. Explicit discard recovers a `running` worktree only when its owner is demonstrably stale. `/workflow-doctor` reports retained recovery state, active locks, unsupported schemas, and running worktrees.

## Todo scheduler

The scheduler launches only initially ready independent nodes in deterministic priority order, keeps successful nodes `doing` pending parent evidence review, stops after failure, and never launches writable children. Hard local limits cover child count, concurrency, duration, completed model turns, and policy compute units. Each model turn costs `relativeCost × thinkingWeight`, where off/minimal/low = 1, medium = 2, high = 3, xhigh = 4, and max = 5. Reservations are divided before each batch and are not recycled from fallible usage telemetry. A child-side guard exits before any model turn beyond its reservation; parent accounting and process termination remain defense in depth.

`targetOutputTokens` and `targetCostUsd` are advisory because the provider exposes no enforceable per-request output cap. Complete usage is reconciled after a response, and no later batch launches after a target is reached. One bounded-concurrency batch may overshoot, and the result reports it.

`todo_schedule` is available only when `--autonomy-scheduler` is enabled. It requires one exact catalog route key and remains read-only.

## Repository navigation and diagnostics

`repository_navigate` generates an uncached point-in-time candidate map with changed-file neighborhoods, instruction hashes, bounded exact matches, symbol/import hints, likely tests, package scripts, workspace facts, and live evidence hashes. Freshness covers HEAD, tree, worktree content, instructions, and workspace configuration. Generation retries once and fails if repository state changes again.

Navigation is advisory and sets `verificationRequired: true`. Read current implementation, applicable instructions, and tests before mutation or product/API decisions.

`/workflow-doctor` distinguishes errors, active ambiguity, warnings, and informational state. It reports observed skill precedence, inactive duplicates, missing or oversized instructions, stale command references, commit-rule conflicts, workspace allowlist leaks, malformed autonomy settings, isolation recovery state, and disabled optional controls. It never edits repositories.

## Telemetry

Autonomy metrics v2 are appended to session JSONL as cumulative aggregate entries. They record operating mode (or `mixed` after a mode-changing resume), lease decisions, policy denial counts, sandbox-shell profiles and outcomes, changed-path counts, delegate usage, and patch conflicts. They do not persist raw prompts, commands, paths, tool arguments, outputs, or credentials. Repeat selectors use a mode-0600 local HMAC key.

Analyze sessions locally:

```bash
npm run session:metrics -- summarize <session-file-or-directory>
npm run session:metrics -- compare --baseline <path> --comparison <path>
```

The analyzer reads only active session ancestry and the latest cumulative autonomy snapshot, so compaction and branch history do not double-count events. Use the workspace metrics-review checklist to evaluate representative sessions.

## Replay benchmark

The benchmark runs command adapters against seven isolated Git fixtures covering clean edits, dirty-worktree preservation, mixed staging, nested instructions, tool failure and retry, compaction and resume, and ambiguous decisions. A strict JSONL protocol rejects malformed events, nonzero exits, timeouts, unmatched scenarios, unknown fields, and per-scenario safety regressions. The synthetic adapter is deterministic. The real-agent adapter invokes Pi inside a filesystem sandbox with a private agent configuration and emits only correlated event categories, numeric usage, fixed evidence tokens, and structured decisions.

The control arm explicitly uses `observe`; the candidate arm uses `canary`. Both use the same prompts, model settings, tools, profiles, and scoped instructions.

```bash
npm run workflow:benchmark -- \
  --control scripts/workflow-benchmark/fixtures/control.json \
  --candidate scripts/workflow-benchmark/fixtures/candidate.json
```

For an authorized model-backed run, use the corresponding real-agent fixture files and an explicit timeout. `--scenarios clean-edit,...` limits diagnosis. Exit code `2` means a safety regression, `1` means harness or input failure, and `64` means invalid CLI usage.

## Operating controls and platform boundary

Use `--no-autonomy-enforce` or mode `observe` for policy diagnostics without blocking. Omit `allowWrites` for read-only delegation, use `sandbox_shell validate` when command writes should be discarded, keep `--autonomy-scheduler` disabled when scheduling is unnecessary, and discard retained worktrees after review.

Writable worktrees and effect-contained shell execution require macOS `sandbox-exec`. Unsupported hosts fail closed or use controlled no-Bash read-only delegation.
