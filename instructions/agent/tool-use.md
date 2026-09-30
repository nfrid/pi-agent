# Tool use

- Choose the evidence needed for the next decision. A single operation defaults to a direct call; use codemode only when composition or projecting results has a real benefit. Don't batch unrelated bookkeeping to justify a batch.
- Batch known-independent reads or checks in one codemode call with `await Promise.allSettled([...])`; stop and return to the model whenever judgment is needed between steps. Await every intended nested operation—script failure does not roll back earlier side effects.
- Read bounded, relevant files and targeted excerpts rather than whole docs or roadmaps. Don't blindly clip essential source; retain enough context to judge it.
- When projecting output, keep the fields needed for judgment and preserve errors, exit codes, truncation status, and full-output paths. Don't hide failures or discard evidence; keep a key or path when the complete result must remain retrievable.
- Discover only when a signature is missing: use `describeTool` for a known tool and `searchTools` for an unknown one. Search results already include signatures.
- Prefer `read`, `edit`, and `write` over shell commands such as `cat` or `sed` for file contents. Keep reads and edits targeted.
- For non-trivial `bash` calls—compound or control-flow commands, mutating commands, or otherwise non-obvious commands—provide the optional `description` field: briefly state the concrete operations, scope, and mutations, not why. Omit it for self-explanatory commands; don't add separate tool-call narration.
