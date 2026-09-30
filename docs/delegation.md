# Delegation

The delegate extension runs focused child agents asynchronously through user-owned model routes. Durable sessions, restart recovery, cancellation, and isolated writable work remain runtime concerns; the parent composes work with four concepts:

```text
inputs   = inherit knowledge
base     = inherit code state into a fresh child
continue = inherit the child session and workspace
gate     = intentionally delay result delivery
```

## Delegate API

`delegate_start` launches a fresh child with a meaningful kebab-case `id`, a focused `task`, and an exact configured `route`:

```json
{
  "id": "reconnect-race-explore",
  "task": "Trace the reconnect handler's event-loss regression; identify the failure mechanism and recommend the smallest fix. Stop before implementation.",
  "route": "luna-m"
}
```

The normal model-facing fields are:

- required `id`, `task`, and `route`;
- optional `inputs`, `base`, `scope`, `write`, `cwd`, `web`, and `skills`.

Fresh delegates explicitly load the local codemode wrapper, including with `--no-extensions`; it disables the native `models.*` API, as in the parent. Optional hybrid codemode remains available, and its existing tool allowlist remains authoritative: codemode composes and discovers only those tools and does not add write or web capabilities.

Fresh delegates default to fresh context. `write: true` gives file-editing tools and automatically selects an isolated Git worktree. `web: true` enables the web tool bundle. `scope` is advisory, not a filesystem boundary. Fresh relative cwd values resolve from the parent cwd; continuations retain their original cwd.

Pass `skills: [".agents/skills/pi-docs/SKILL.md"]` when a child needs a specific workflow. Up to 16 explicit skill files or directories can be selected. Paths resolve against the fresh requested cwd before worktree isolation; `~` uses the effective home directory. Children do not discover the parent's normal skill catalog. Selection loads the skill catalog entry, so the delegated task should make its intended use clear. Skill files remain at their resolved source paths, not copied or version-pinned in the child worktree.

`delegate_continue` resumes the same child session and retained workspace. It accepts only `continue`, `task`, and optional `route` and `scope`:

```json
{
  "continue": "reconnect-race-fix",
  "task": "Address the review findings and rerun the relevant checks."
}
```

Continuations inherit route, cwd, write access, isolation, web access, selected skill paths, and latest scope. Do not supply `skills` on a continuation; the original selection cannot be replaced. The parent does not repeat `write: true`. A supplied route may replace the inherited route with another exact configured route; a supplied scope replaces the latest advisory scope.

If the next task needs different capabilities or skills, start a fresh delegate with `inputs`; use `base` when it also needs the predecessor's code state. For example, follow a read-only investigation with a fresh `write: true` delegate that takes the investigation as an input.

## Knowledge and code flow

`inputs` waits for each referenced node or exact attempt to settle, then gives the downstream child its compact handoff inline and a full-report path when needed:

```json
{
  "id": "reconnect-race-fix",
  "task": "Implement and verify the reconnect race fix.",
  "route": "luna-h",
  "inputs": ["reconnect-race-explore"],
  "scope": ["apps/dashboard-server"],
  "write": true
}
```

Bare references bind to immutable exact attempts when admitted. There is no separate ordering-only dependency in the model API.

Settlement is not approval: `inputs` does not interpret an upstream recommendation or require a successful outcome. If an investigation determines whether a migration is needed, read its result before scheduling the migration. Pre-schedule downstream tasks only when that decision is already settled.

`base` starts a fresh child in a fresh isolated workspace at another delegate's exact resulting code state. It also implies that node as an input:

```json
{
  "id": "reconnect-race-review",
  "task": "Review the implementation for correctness, regressions, and unnecessary complexity.",
  "route": "astra-l",
  "base": "reconnect-race-fix"
}
```

Base chains are cumulative. For `A --base--> B --base--> C`, C starts from A and B's resulting code. `delegate_changes review` shows the selected node's own delta from its immediate base; merging C integrates the cumulative chain.

## Result delivery and gates

Every newly settled result is delivered eagerly at the next safe model boundary. Results ready before the same boundary enter the same parent turn. When other work remains active, delivery includes a compact `Still running` list. Do not poll. To keep the current user request open for an exact delegate completion, call `response_wait` with `{ "kind": "delegate", "id": "<attempt-identity>" }` from the `workflow.identity` receipt. The tool canonicalizes a returned job ID or unambiguous logical ID to that attempt. Ambiguous or unknown IDs fail before any wait is recorded. Queued delivery does not resolve the wait until that result enters model context.

Do not call `delegate_gate` for ordinary result delivery. Newly settled delegates already arrive as `any` at the next safe model boundary. Use a gate only to batch an `all` fan-in or to delay an `any` race until idle. Exactly one explicit gate is active per parent branch; a later call replaces it.

Batch a fan-in:

```json
{
  "mode": "all",
  "delegates": ["transport-audit", "persistence-audit"]
}
```

Delay a race until the parent would otherwise become idle:

```json
{
  "mode": "any",
  "delegates": ["hypothesis-a", "hypothesis-b"],
  "delivery": "idle"
}
```

`delivery` defaults to `safe`, which is already the ordinary behavior for `any`. An `any` gate is consumed after the first eligible delivery; remaining delegates return to eager delivery.

## Report contract

Children return concise prose. Only `Outcome` and `Conclusion` are required:

```text
Outcome: done | partial | blocked | failed
Conclusion: the answer or completed work
Evidence: file:line and checks run
Risks: material risks left unresolved
Blocked: the one question the parent must answer
```

Reports that fit are delivered inline; oversized reports are written to an owner-readable Markdown file under Pi's local cache and referenced by the bounded handoff. Large supporting outputs should be ordinary files.

## Operational controls

`delegate_jobs` provides metadata (`list`, `status`), a bounded activity snapshot (`inspect`), corrective `feedback`, and `cancel`. Address work by logical node or exact attempt reference.

```json
{ "action": "inspect", "id": "reconnect-race-fix" }
```

Inspection shows state and timing, recent assistant progress messages, and compact tool activity with status and brief errors when available. It excludes thinking, full tool results, file contents, and edit payloads. Missing activity and truncation are explicit; settled attempts return metadata rather than their final report. Inspection does not consume or alter automatic completion delivery.

Inspect only when the evidence could change a steering, cancellation, or coordination decision—not to wait for completion or routinely supervise every delegate. Use `feedback` for a bounded correction. Never loop or alternate sleeps with `list`, `status`, or `inspect` to wait for settlement; these are not result-retrieval APIs.

`/pause` gates the parent and active delegates at provider-safe boundaries. `/continue` releases them and resumes queued delivery.

## Reviewing and integrating changes

Use `delegate_changes` with a workflow node:

```json
{ "action": "review", "node": "reconnect-race-fix" }
```

```json
{
  "action": "merge",
  "node": "reconnect-race-fix",
  "message": "fix(session): preserve reconnect state"
}
```

`review` defaults to the node's own delta from its base. Optional `summaryOnly`, exact repository-relative `paths`, and `patchBudget` bound the view. The review-only `incremental: true` selector shows task commits not represented in the current parent HEAD by patch identity; omit it or set it to `false` for the full recorded-range audit view. Review before `merge`; merge requires a meaningful parent-supplied Conventional Commit message and lands the cumulative delegate work as one ordinary squash commit, or leaves the parent checkout untouched. Do not rebase or manually merge the retained child history. Caller-owned worktrees remain review-only and caller-managed. The `/delegate-worktrees` command is an operational recovery view for retained checkout records.

## Route selection

Fresh tasks choose one exact key from `delegate.modelCatalog`; unknown routes fail. Continuations inherit their route unless explicitly replaced.

Choose the cheapest route capable of completing the brief reliably. Each configured route has a short `useFor` task shape; user-owned catalogs may also specify an optional `avoid` exclusion, which must be respected. `relativeCost` is benchmark-relative total task cost, not a quality score or token-price ratio.

| Route | Task shape |
| --- | --- |
| `luna-l` | Mechanical execution with an exact verifier |
| `luna-m` | Localized implementation or investigation with a clear question and finish line |
| `luna-h` | Substantial bounded work across known files or components |
| `luna-x` | Difficult bounded diagnosis, implementation, or verification |
| `luna-max` | Exceptional bounded work where unusually deep reasoning is justified |
| `sol-m` | Work requiring the child to choose the approach, scope, or evaluation criteria |
| `astra-l` | High-stakes cross-subsystem design or diagnosis beyond Sol's expected reliability, or a concrete unresolved issue after a Sol attempt |

The checked-in catalog uses GPT-6 Luna, GPT-6.1 Sol, and GPT-6 Astra. The `sol-m` route retains Sol's previous provisional cost estimate pending calibration of GPT-6.1 Sol. Its `relativeCost` values are **provisional estimates**, not measured GPT-6 route costs. Pending local calibration, Luna retains the historical effort ratios `1/3/11/21/42`; Sol medium is `95` and Astra low is `190`, normalized to GPT-6 Luna low. These rough estimates apply cost-per-task factors of `0.4` for Luna and `0.5` for Sol to the previous catalog's costs (Luna low `1`, Sol medium `75`, Astra low `75`), then renormalize and round. The factors come from [Artificial Analysis's GPT-6 release evaluation](https://artificialanalysis.ai/articles/gpt-6-sol-and-luna-push-the-cost-efficiency-frontier) at **max** effort; transferring them to other efforts is an unverified assumption. Calibrate cost and successful completion on representative local tasks before treating these ratios as measurements, particularly because Luna's coding score regressed slightly in that evaluation.

Searching unfamiliar code is not, by itself, a reason to choose Sol or Astra. Prefer a smaller task over a deeper route when decomposition preserves useful independence. Routing remains the parent's choice; there is no additional model call.

## Orchestration policy

For substantial tasks, default to orchestrating bounded investigation and/or implementation. Reconnoiter enough to write a useful brief, but do not finish the investigation before delegating. Run independent workstreams concurrently when that shortens the critical path, while avoiding duplicated child work and needless fleets.

A child may own a coherent investigation, implementation, and focused tests together; a separate review child is not mandatory. The parent owns scope decisions, integration, and final verification. Work directly for trivial tasks, tightly coupled fixes, or when delegation's briefing, latency, verification, and integration overhead clearly dominates.

For uncertain work, a useful first task may be to identify the failure mechanism and recommend the smallest fix, stopping before implementation. For a straightforward fix, keeping investigation, implementation, and focused verification together can avoid unnecessary handoffs.
