export function buildDelegatePrompt(task: string): string {
	return `${task}

Complete the delegated task and return a concise, decision-useful result to the parent. Include concrete evidence where useful, state uncertainty or failures clearly, and do not narrate routine tool calls.

Treat the project as read-only by default: do not edit, create, delete, or move project files unless this task explicitly authorizes filesystem changes. Read-only inspection and validation commands are allowed.`;
}
