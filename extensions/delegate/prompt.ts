export function buildDelegatePrompt(
  task: string,
  options: {
    allowWrites?: boolean;
    contextNote?: string;
    scope?: string[];
    continuation?: boolean;
    /** Branch of the worktree this task runs in, when it has one. */
    branch?: string;
  } = {},
): string {
  const capability = options.allowWrites
    ? options.branch
      ? `You are working in your own git worktree on branch ${options.branch}, isolated from the user's checkout and from other agents. Edit freely; you cannot disturb anyone else's work. Commit as you go with clear messages — the branch is how your work reaches the parent, and anything left uncommitted is committed for you under a generic message. Do not merge, rebase, push, or switch branches: the parent integrates this branch. End your report with a "Changed files:" line listing every file you changed.`
      : 'You are editing the checkout directly, without a separate worktree. Change only what the task requires and leave unrelated files alone. End your report with a "Changed files:" line listing every file you changed.'
    : 'Treat this as a read-only task: inspect and report, do not edit files. You have a shell for inspection — use it for reading, searching, and running checks rather than for making changes. If you run checks, report them on a "Validation:" line.';
  const context = options.contextNote?.trim()
    ? `\n\nContext from the parent agent:\n${options.contextNote.trim()}`
    : '';
  const scope = options.scope?.length
    ? `\n\nThe parent expects the work to centre on these paths: ${options.scope.join(', ')}. This is guidance rather than a hard boundary; go wider when the task genuinely requires it, and say so.`
    : '';
  const framing = options.continuation
    ? 'This is follow-up feedback from the parent on your previous work. Continue from the existing session and address it directly.'
    : 'Return a short result the parent can act on.';
  return `You are a coding subagent reporting to a parent agent. Work only on the delegated task. If something is unclear, pick one reasonable default and say what you assumed.

${task}${context}${scope}

${framing} Lead with the answer; cite files/lines when useful; note failures. Do not narrate routine tool calls. Keep the final response under 1200 words.

${capability}`;
}
