# Delegation

The delegate extension runs focused child agents asynchronously through user-owned model routes. Durable sessions, restart recovery, cancellation, and isolated writable work remain runtime concerns; the parent composes work with four concepts:

```text
inputs   = inherit knowledge
base     = inherit code state into a fresh child
continue = inherit the child session and workspace
gate     = intentionally delay result delivery
```

## Delegate API

A fresh child uses a meaningful kebab-case `id`, a focused `task`, and an exact configured `route`:

```json
{
  "id": "reconnect-race-explore",
  "task": "Find why reconnect can lose events and recommend the smallest sound fix.",
  "route": "luna-high"
}
```

The normal model-facing fields are:

- exactly one of `id` or `continue`;
- required `task`;
- optional `route`, `inputs`, `base`, `scope`, `write`, `cwd`, and `web`.

Fresh delegates default to fresh context. `write: true` gives file-editing tools and automatically selects an isolated Git worktree. `web: true` enables the web tool bundle. `scope` is advisory, not a filesystem boundary. Fresh relative cwd values resolve from the parent cwd; continuations retain their original cwd.

A continuation resumes the same child session and retained workspace:

```json
{
  "continue": "reconnect-race-fix",
  "task": "Address the review findings and rerun the relevant checks."
}
```

Continuations inherit route, cwd, write access, isolation, web access, and latest scope. The parent does not repeat `write: true`. A supplied route may replace the inherited route with another exact configured route; a supplied scope replaces the latest advisory scope.

## Knowledge and code flow

`inputs` waits for each referenced node or exact attempt, then gives the downstream child its compact handoff inline and the durable full-report path:

```json
{
  "id": "reconnect-race-fix",
  "task": "Implement and verify the reconnect race fix.",
  "route": "luna-high",
  "inputs": ["reconnect-race-explore"],
  "scope": ["apps/dashboard-server"],
  "write": true
}
```

Bare references bind to immutable exact attempts when admitted. There is no separate ordering-only dependency in the model API.

`base` starts a fresh child in a fresh isolated workspace at another delegate's exact resulting code state. It also implies that node as an input:

```json
{
  "id": "reconnect-race-review",
  "task": "Review the implementation for correctness, regressions, and unnecessary complexity.",
  "route": "sol-medium",
  "base": "reconnect-race-fix"
}
```

Base chains are cumulative. For `A --base--> B --base--> C`, C starts from A and B's resulting code. `delegate_changes review` shows the selected node's own delta from its immediate base; merging C integrates the cumulative chain.

## Result delivery and gates

Every newly settled result is delivered eagerly at the next safe model boundary. Results ready before the same boundary enter the same parent turn. When other work remains active, delivery includes a compact `Still running` list. Do not poll.

Do not call `delegate_gate` for ordinary result delivery. Newly settled delegates already arrive as `any` at the next safe model boundary. Use a gate only to batch an `all` fan-in or to delay an `any` race until idle. Exactly one explicit gate is active per parent branch; a later call replaces it.

Batch a fan-in:

```json
{
  "all": ["transport-audit", "persistence-audit"]
}
```

Delay a race until the parent would otherwise become idle:

```json
{
  "any": ["hypothesis-a", "hypothesis-b"],
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

Every exact final report is also written to an owner-readable Markdown file under Pi's local cache. Parent delivery and downstream inputs use the bounded handoff plus that path. Large supporting outputs should be ordinary files.

## Operational controls

`delegate_jobs` remains available for one status snapshot when it changes an immediate feedback or cancellation decision, one feedback message to active work, and cancellation. Address work by logical node reference when possible. Never alternate sleeps with `list` or `status` to wait for settlement; this is not a result-retrieval API.

`/pause` gates the parent and active delegates at provider-safe boundaries. `/continue` releases them and resumes queued delivery.

## Reviewing and integrating changes

Use `delegate_changes` with a workflow node:

```json
{ "action": "review", "node": "reconnect-race-fix" }
```

```json
{ "action": "merge", "node": "reconnect-race-fix" }
```

`review` defaults to the node's own delta from its base. Optional `summaryOnly`, exact repository-relative `paths`, and `patchBudget` bound the view. `merge` either lands cleanly or leaves the parent checkout untouched. Caller-owned worktrees remain review-only and caller-managed. The `/delegate-worktrees` command is an operational recovery view for retained checkout records.

## Route selection

Fresh tasks choose one exact key from `delegate.modelCatalog`; unknown routes fail. Continuations inherit their route unless explicitly replaced.

The configured catalog uses Luna routes for bounded background work and Sol routes for maintainer judgement about what completion or quality should mean. Choose the cheapest route whose `useFor` matches and whose `avoid` does not. `relativeCost` is benchmark-relative total task cost, not a quality score or token-price ratio.

No prompt or active configuration should refer to unavailable route families.
