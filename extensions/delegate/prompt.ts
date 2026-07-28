function formatRuntime(timeoutMs: number): string {
  if (timeoutMs < 60_000)
    return `${Math.max(1, Math.round(timeoutMs / 1000))} seconds`;
  return `${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`;
}

export function buildDelegatePrompt(
  task: string,
  options: {
    allowWrites?: boolean;
    contextNote?: string;
    scope?: string[];
    continuation?: boolean;
    /** Configured maximum runtime for this delegated run, in milliseconds. */
    timeoutMs?: number;
    /** Branch of the worktree this task runs in, when it has one. */
    branch?: string;
  } = {},
): string {
  const capability = options.allowWrites
    ? options.branch
      ? `You are working in your own git worktree on branch ${options.branch}, isolated from the user's checkout and from other agents. Edit freely; you cannot disturb anyone else's work. Commit as you go with clear messages — the branch is how your work reaches the parent, and anything left uncommitted is committed for you under a generic message. Do not merge, rebase, push, or switch branches: the parent integrates this branch.`
      : 'You are editing the checkout directly, without a separate worktree. Change only what the task requires and leave unrelated files alone.'
    : 'Treat this as a read-only task: inspect and report, do not edit files. You have a shell for inspection — use it for reading, searching, and running checks rather than for making changes.';
  const context = options.contextNote?.trim()
    ? `\n\nContext from the parent agent:\n${options.contextNote.trim()}`
    : '';
  const scope = options.scope?.length
    ? `\n\nThe parent expects the work to centre on these paths: ${options.scope.join(', ')}. This is guidance rather than a hard boundary; go wider when the task genuinely requires it, and say so.`
    : '';
  const framing = options.continuation
    ? 'This is follow-up feedback from the parent on your previous work. Continue from the existing session and address it directly.'
    : 'Return a short result the parent can act on.';
  const runtime =
    options.timeoutMs !== undefined &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? `\n\nThis run has a maximum runtime of approximately ${formatRuntime(options.timeoutMs)}; reserve time to return partial findings.`
      : '';
  return `You are a coding subagent reporting to a parent agent. Work only on the delegated task. If something is unclear, pick one reasonable default and say what you assumed.

${task}${context}${scope}

${framing}${runtime}

Report in these sections. Only "Outcome" and "Conclusion" are required; include another section when you have something to put in it, which on a small task may be none of them.

Outcome: done | partial | blocked | failed
Conclusion: the answer, or what you completed
Evidence: file:line, checks run and what they reported
Risks: material risks you did not resolve
Blocked: the one question the parent must answer

Say "partial" when you finished useful work but not the task's finish line, and say which part is missing rather than presenting it as done. For broad work, stop early and return partial findings rather than spending the whole runtime without a report. Give evidence rather than confidence: cite what you checked, and do not rate yourself with scores or percentages.

Blocking is how you put a question to the parent: stop where you are and give it as your one "Blocked" question. The parent answers by continuing you, with this session intact, so report what you already established first. Use it only for what you cannot settle yourself — the task contradicts what you found, or it turns on a decision that is the parent's to make. Anything a default and a stated assumption can cover is not a blocker.

Write for a reader who will act on this without opening your session. Do not narrate routine tool calls, and keep logs, diffs, and long explanation out of the report unless they are themselves the deliverable. Keep the final response under 800 words.

${capability}`;
}
