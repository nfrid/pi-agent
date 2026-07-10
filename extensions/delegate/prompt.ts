export function buildDelegatePrompt(task: string, allowWrites = false): string {
	const capability = allowWrites
		? "This task explicitly permits filesystem changes. Change only what the task requires and report the files changed."
		: "Treat this as a read-only task. Bash is available for inspection and validation, but do not use it to edit, create, delete, or move files.";
	return `${task}

Complete the delegated task and return a concise, decision-useful result to the parent. Lead with conclusions, include concrete file/line evidence where useful, state uncertainty or failures clearly, and do not narrate routine tool calls. Keep the final response under 1200 words.

${capability}`;
}
