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
