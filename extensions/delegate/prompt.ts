export function buildDelegatePrompt(
  task: string,
  options: {
    allowWrites?: boolean;
    contextNote?: string;
    scope?: string[];
    continuation?: boolean;
  } = {},
): string {
  const capability = options.allowWrites
    ? 'This task explicitly permits filesystem changes. Change only what the task requires and report the files changed.'
    : 'Treat this as a read-only task. Bash is available for inspection and validation, but do not use it to edit, create, delete, or move files.';
  const context = options.contextNote?.trim()
    ? `\n\nContext from the parent agent:\n${options.contextNote.trim()}`
    : '';
  const scope = options.scope?.length
    ? `\n\nThe parent expects work to stay mainly within these paths: ${options.scope.join(', ')}. This is guidance, not a hard boundary: expand beyond it when the task genuinely requires it, and explain why.`
    : '';
  const framing = options.continuation
    ? 'This is follow-up feedback from the parent on your previous work. Continue from the existing session and address it directly.'
    : 'Complete the delegated task and return a concise, decision-useful result to the parent.';
  return `${task}${context}${scope}

${framing} Lead with conclusions, include concrete file/line evidence where useful, state uncertainty or failures clearly, and do not narrate routine tool calls. Keep the final response under 1200 words.

${capability}`;
}
