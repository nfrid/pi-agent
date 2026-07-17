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
    ? 'This task runs in an isolated worktree with an OS-enforced writable scope. Change only what the task requires inside that scope, do not modify Git metadata, and report the files changed. The parent will inspect the exact patch before any application.'
    : 'Treat this as a read-only task. Bash is available for inspection and validation, but do not use it to edit, create, delete, or move files.';
  const context = options.contextNote?.trim()
    ? `\n\nContext from the parent agent:\n${options.contextNote.trim()}`
    : '';
  const scope = options.scope?.length
    ? options.allowWrites
      ? `\n\nWritable scope (hard boundary): ${options.scope.join(', ')}. If more paths are required, stop and ask the parent to start a new isolated run with the expanded scope.`
      : `\n\nThe parent expects inspection to focus mainly on these paths: ${options.scope.join(', ')}. This is guidance, not a hard boundary for a read-only task; broader inspection is allowed when useful.`
    : '';
  const framing = options.continuation
    ? 'This is follow-up feedback from the parent on your previous work. Continue from the existing session and address it directly.'
    : 'Complete the delegated task and return a concise, decision-useful result to the parent.';
  return `${task}${context}${scope}

${framing} Lead with conclusions, include concrete file/line evidence where useful, state uncertainty or failures clearly, and do not narrate routine tool calls. Keep the final response under 1200 words.

${capability}`;
}
