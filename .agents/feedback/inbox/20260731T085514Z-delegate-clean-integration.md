# HF-20260731: Delegate integration cannot squash a retained branch

- **Status:** triaged
- **Observed date:** 2026-07-31
- **Source cwd/repo:** `/Users/nfrid/job`, `tracker-cli`
- **Task shape:** Multi-file TypeScript implementation delegated to a writable isolated worktree, with project commit-message requirements.
- **Harness component:** `delegate_branches merge`
- **Route / attempt / outcome:** Luna xhigh implementation timed out and was continued successfully; its retained branch contained one non-conventional partial commit plus valid follow-ups.
- **Observed cost / rework:** A second writable delegate had to replay the exact 13-path tree diff onto a fresh branch solely to produce one acceptable Conventional Commit.
- **Recurrence / confidence:** Likely whenever a retained branch has useful file state but unsuitable commit history; high confidence from direct observation.
- **Ticket:** [HFM-20260731: Add squash integration for writable delegates](../tickets/20260731-add-squash-delegate-integration.md)

## Behavior

`delegate_branches merge` integrates the retained branch history as-is. There is no supported clean-tree or squash integration mode that can apply the reviewed final tree as one new commit on the parent. In this session, merging the original branch would have preserved a timeout-generated commit named `JSON contract implementer`, which violated repository commit conventions.

## Impact

The safe workaround consumed another delegate run, another retained worktree, and another full validation cycle despite the final file diff already being reviewed and correct. Without that workaround, the parent would either receive invalid history or require an unauthorized history rewrite/manual integration path.

## Evidence

- Original retained branch: `pi/json-contract-implementer`.
- Unsuitable partial commit: `a6e6474 JSON contract implementer`.
- Clean replay branch: `pi/json-contract-clean-integrator`.
- Exact-tree verification reported zero diff across the 13 task paths before committing `311d1ec feat(cli): add versioned JSON output contract`.
- No product defect required the replay; it existed only to normalize integration history.

## Smallest improvement

Add a supported `delegate_branches` integration mode that applies the reviewed retained tree as one new commit on the unchanged parent, with a caller-supplied commit subject, while preserving the current fail-closed conflict behavior.
