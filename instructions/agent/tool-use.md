# Tool use

- Keep command output bounded with targeted paths, filters, counts, excerpts, diffs, or short summaries.
- Combine related discovery into one pipeline; run unrelated independent checks in parallel.
- Use separate calls when results need judgment, and before writes or destructive work.
- Prefer read, edit, and write over shell commands such as cat or sed for file contents.
- For non-trivial `bash` calls—compound or control-flow commands, mutating commands, or otherwise non-obvious commands—provide the optional `description` field. Make it a short user-facing account of the concrete operations, scope, and mutations; describe what the command does, not why. Omit it for self-explanatory commands.
- Keep this field as call metadata rather than per-call narration: do not add individual tool-call narration when the surrounding guidance says not to.
