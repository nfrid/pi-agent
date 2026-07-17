# Delegation

The delegate extension runs focused child agents using user-owned model routes. Parent-agent shell and repository access are unaffected by delegation settings.

## Route selection

Every fresh delegated task supplies one exact `route` key from `delegate.modelCatalog`. A continuation reuses its persisted route when omitted and may switch only by supplying another complete route key. Parallel tasks may share a top-level route or select routes independently.

Each route binds one provider, model, and thinking level. `relativeCost` is used for route admission and `relativeIntelligence` is role-neutral selection guidance; neither field grants repository or tool access. `delegate.maxRelativeCost` is the hard route ceiling. Unknown and over-cost routes fail rather than silently substituting.

```json
{
  "delegate": {
    "maxRelativeCost": 21,
    "modelCatalog": {
      "luna-medium": {
        "provider": "openai-codex",
        "model": "gpt-5.6-luna",
        "thinking": "medium",
        "relativeCost": 2,
        "relativeIntelligence": 59,
        "description": "Focused repository inspection and scoped coding"
      }
    }
  }
}
```

The compact routing table is included in the parent system prompt when the delegate tool is available. Delegated children do not receive orchestration instructions.

## Read-only delegates

Read-only delegates receive controlled inspection tools. On supported macOS hosts, `inspect_shell` provides Bash-compatible read-only commands inside `sandbox-exec`; filesystem writes, network access, process signaling, and inherited secrets are denied. If that boundary is unavailable, Bash is omitted and controlled `read`, `grep`, `find`, and `ls` tools remain.

The child model process receives only a minimal environment. Provider authentication is copied to a private mode-0600 startup directory and scrubbed when the child exits. Credential values are never exposed to child tools.

Commands that require build output or repository-local cache writes should use writable isolation or parent validation rather than weakening the read-only boundary.

## Writable delegates

Writable execution requires `allowWrites: true` and at least one existing repository-relative `scope` path. The extension creates a detached locked Git worktree and restricts child writes to declared worktree paths and private state. Writable children receive controlled read/edit/write tools and no Bash.

A continuation reuses its original worktree, working directory, route, and scope. It must repeat `allowWrites: true` to edit. Parallel writable tasks require non-overlapping scopes. If writable isolation cannot be established, the run falls back to enforceable read-only execution and reports why.

`dependencies: auto` may reuse unchanged repository dependencies through a read-only filesystem boundary. Linked dependencies are detached before validation. Frozen offline installation with lifecycle scripts disabled provisions isolated dependencies when a supported lockfile exists. `dependencies: isolated` never reuses parent dependencies.

After each writable run, the extension captures and hashes the cumulative binary patch against the original base, validates path and symlink safety, and retains the worktree in user state outside the target repository. It never applies a child patch automatically.

## Patch lifecycle

```text
/delegate-patch list
/delegate-patch <id-or-continuation> show
/delegate-patch <id-or-continuation> diff
/delegate-patch <id-or-continuation> validate <package-script>
/delegate-patch <id-or-continuation> validate-command <executable> [args...]
/delegate-patch <id-or-continuation> apply
/delegate-patch <id-or-continuation> discard
```

Validation binds either the exact package-script definition or exact executable argv, uses a minimal environment, denies network and process signaling, and fails if the patch changes. Apply requires a successful child, passed validation, a matching patch hash, an unchanged clean parent, isolation locks, and `git apply --check`.

Concurrent lifecycle operations are locked. Explicit discard can recover a `running` worktree only when its recorded owner is demonstrably stale. A concurrent parent edit is reported as a conflict; automatic rollback never overwrites external work.
