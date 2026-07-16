# Scoped instructions

This extension is opt-in with `--scoped-instructions` (default: `false`). It only
intercepts Pi's `edit` and `write` tools. **It does not cover or claim to cover
mutations performed through `bash` or other tools.**

A repository may define `.pi/scoped-instructions.json`:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "source-safety",
      "scope": "src/",
      "intents": ["edit", "write"],
      "instructionFiles": [".pi/instructions/source-safety.md"],
      "critical": false
    }
  ]
}
```

Version 1 is strict: unknown fields, duplicate IDs/intents/files, malformed
rules, absolute paths, backslashes, empty/dot/traversal path segments, and
instruction symlink escapes reject the complete manifest. Scopes are portable
relative directory prefixes ending in `/`; `.` means the repository root.
Targets are canonicalized before matching and targets outside the repository,
including symlink escapes, are blocked.

Whole-file reads are guarded by on-disk size checks. Version 1 limits are:

- manifest: 64 KiB (`MAX_MANIFEST_BYTES`)
- rules: 64 (`MAX_RULE_COUNT`)
- instruction files per rule: 8 (`MAX_FILES_PER_RULE`)
- each instruction file: 64 KiB (`MAX_INSTRUCTION_BYTES`)
- all referenced instruction content: 256 KiB (`MAX_TOTAL_INSTRUCTION_BYTES`)
- formatted critical eager content: 128 KiB
  (`MAX_TOTAL_CRITICAL_EAGER_BYTES`)

Limits are exported from `core.ts`. Any overflow rejects the manifest atomically;
when enabled, covered `edit`/`write` calls then fail closed.

All critical rule files are loaded into the system prompt before an agent turn,
regardless of scope or intent. An applicable non-critical rule blocks its first
`edit`/`write` call before mutation and returns the exact instruction text; the
model must review it and retry. A retry of a covered mutation is allowed only
while manifest/rule hashes remain unchanged; it need not be an identical tool
call. Rule/content hashes make changed rules unseen again.
`/scoped-instructions` reports current rules, hashes, reasons, and the
explicit coverage limitation. Diagnostic decisions are also stored as
`scoped-instructions-diagnostic-v1` custom session entries.

No repository manifest is included by default.
