---
name: unslop
description: Edit prose for plain, concise language when the user requests a writing or style pass. Not required for routine coding responses.
disable-model-invocation: true
---

# Plain-language editing

Use this skill when explicitly requested, including through `/skill:unslop`.
Preserve the author's meaning, factual qualifications, technical terms, and
intended audience. Do not invent opinions, personality, or evidence.

## Editing pass

- Replace filler and promotional claims with concrete facts, or remove them.
- Prefer common words where they are equally precise. Keep necessary jargon.
- Split sentences that are hard to follow. Prefer active voice when the actor
  is known; passive voice is fine when it is clearer.
- Remove repeated points, routine narration, and generic openings or endings.
- Use headings and lists only when they help readers find or compare information.
- Choose punctuation for clarity. Do not enforce blanket word or punctuation bans.
- Keep uncertainty where the evidence warrants it. Do not turn a qualified claim
  into certainty just to shorten it.

Reread the result for meaning and readability. Return the edited text without
an editing report unless the user asks for one.
