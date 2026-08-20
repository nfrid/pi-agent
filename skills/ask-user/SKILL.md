---
name: ask-user
description: Ask the user for decisions, preferences, clarifications, or missing information through a normal final response. Use when the agent cannot proceed without user input.
---

# Ask the user

Ask questions through a normal final response, not through a special tool or UI.

- Batch independent questions together.
- Number each question and give likely answers as lettered choices.
- Accept compact replies such as `1a, 2c`, along with clarifications and custom answers.
- Ask sequentially only when a later question depends on an earlier answer.
- Ask only when the answer belongs to the user; make reasonable choices yourself otherwise.
- After asking, settle: do not use a tool or generate HTML/CLI output unless the user genuinely requested a rich comparison.
