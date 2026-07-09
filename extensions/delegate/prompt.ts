export function buildDelegatePrompt(task: string): string {
	return `${task}

When you are done, report back to the parent agent with only decision-useful information.

Use this exact structure:

## Result

State the outcome in concise bullets. Mention whether the task is complete, partial, blocked, or failed. If files changed, list them; if not, say no changes made.

## Findings

Give the useful substance: answer, root cause, plan, review notes, implementation notes, or validation result. Keep it dense and actionable.

## Evidence

Include concrete anchors needed to trust or continue the work: paths, symbols, commands/results, tests, errors, or short decisive snippets.

## Next

List recommended next steps, remaining risks, or "Nothing".

Rules:
- Do not narrate every tool call.
- Prefer exact paths/symbols over vague summaries.
- Include validation performed and what it proves.
- If validation was not run and that matters, say so.
- Surface uncertainty instead of guessing.`;
}
