---
name: pi-docs
description:
  Guidance for using Pi coding agent documentation, SDK docs, extension
  examples, themes, skills, prompt templates, TUI APIs, keybindings, custom
  providers, model configuration, and Pi packages. Use when the user asks about
  Pi itself or asks to implement/customize Pi extensions, skills, themes,
  providers, prompts, or TUI behavior.
---

# Pi Documentation

## Documentation locations

- Main documentation:
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- Additional docs:
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs`
- Examples:
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples`

## Topic map

When asked about a Pi topic, read the relevant docs and examples before
answering or implementing:

- Extensions: `docs/extensions.md`, `examples/extensions/`
- Themes: `docs/themes.md`
- Skills: `docs/skills.md`
- Prompt templates: `docs/prompt-templates.md`
- TUI components/API: `docs/tui.md`
- Keybindings: `docs/keybindings.md`
- SDK integrations: `docs/sdk.md`
- Custom providers: `docs/custom-provider.md`
- Adding models: `docs/models.md`
- Pi packages: `docs/packages.md`

## Required workflow

1. Resolve `docs/...` paths under the Additional docs directory, not the current
   working directory.
2. Resolve `examples/...` paths under the Examples directory, not the current
   working directory.
3. Read Pi Markdown files completely. If a file is truncated by the read tool,
   continue with `offset` until complete.
4. Follow relevant `.md` cross-references before implementing or giving detailed
   guidance.
5. For extension/example implementation tasks, inspect the matching examples
   under the Examples directory.
6. Prefer code changes under `extensions/` in this repo unless the user requests
   another location.
