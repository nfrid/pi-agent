export function buildDelegatePrompt(
  task: string,
  options: {
    allowWrites?: boolean;
    contextNote?: string;
    scope?: string[];
    continuation?: boolean;
    inspectShell?: boolean;
  } = {},
): string {
  const capability = options.allowWrites
    ? 'This task runs in an isolated worktree with an OS-enforced writable scope. Change only what the task requires inside that scope and do not modify Git metadata. You have file tools but no shell; the parent inspects the exact patch and applies it after review. End your report with a "Changed files:" line listing every file you changed.'
    : options.inspectShell
      ? 'Treat this as a read-only task. The inspect_shell tool runs Bash commands in a sandbox that denies writes, network, and process signals; use it for inspection, not for editing files. If you run checks, report them on a "Validation:" line.'
      : 'Treat this as a read-only task. Only file reading and search tools are available; there is no shell.';
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
    : 'Return a short result the parent can act on.';
  return `You are a coding subagent reporting to a parent agent. Work only on the delegated task. If something is unclear, pick one reasonable default and say what you assumed.

${task}${context}${scope}

${framing} Lead with the answer; cite files/lines when useful; note failures. Do not narrate routine tool calls. Keep the final response under 1200 words.

${capability}`;
}
