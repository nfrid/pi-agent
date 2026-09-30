# System prompt

The system-prompt extension is the canonical owner of the emitted system prompt.
Its composition order is role and tools, guidelines, shared agent instructions,
project context, skills, then date and working-directory metadata.

Supported prompt sources are shared instruction files, tool metadata and
structured guidelines, loaded project context files, and skills. `customPrompt`
and `appendSystemPrompt` inputs are discarded. Text supplied by an earlier
`before_agent_start` hook is overwritten by this owner; a later hook can still
replace the result.

When a nonempty direct prompt input is discarded, the extension warns once per
session without including the input text. It uses Pi UI notifications where UI
is available and stderr-safe output in headless modes. After changing prompt
sources, use `/reload` to reload the extension and start a fresh prompt
composition; later hooks may still affect the final emitted prompt.

## Tool interface

The default configuration uses `codemode.mode: "on"`: ordinary tools remain
available directly, and codemode is optional for useful batching, composition,
and filtering. A single operation defaults to a direct call; steps that need
model judgment between them remain separate. Discovery is only needed when a
tool's signature is missing, and search results already contain signatures.

The native codemode model catalog/classifier API remains enabled. Ordinary
chat models cannot be passed to `models.classify` unless registered with a
classifier implementation. This policy does not change delegate model routing,
tool allowlists, or web/write permissions.

Reload extensions and start a new session after changing the tool configuration.
Use `/prompt-info` for prompt diagnostics and `bun run session:metrics` for
recorded usage; neither replaces a matched behavioral comparison. The hybrid
policy is a usability change, not a measured claim of lower total task cost.
