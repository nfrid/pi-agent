interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

function containsToolCall(entry: unknown, toolCallId: string): boolean {
	if (!entry || typeof entry !== "object") return false;
	const message = (entry as { message?: unknown }).message;
	if (!message || typeof message !== "object") return false;
	const content = (message as { content?: unknown }).content;
	return (
		Array.isArray(content) &&
		content.some(
			(part) =>
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "toolCall" &&
				(part as { id?: unknown }).id === toolCallId,
		)
	);
}

export function buildSessionSnapshotJsonl(
	sessionManager: SessionSnapshotSource,
	options: { cwd?: string; excludeToolCallId?: string } = {},
): string | null {
	const sourceHeader = sessionManager.getHeader();
	if (!sourceHeader || typeof sourceHeader !== "object") return null;
	const header = options.cwd
		? { ...(sourceHeader as Record<string, unknown>), cwd: options.cwd }
		: sourceHeader;
	const branch = sessionManager.getBranch();
	const cutoff = options.excludeToolCallId
		? branch.findIndex((entry) =>
				containsToolCall(entry, options.excludeToolCallId as string),
			)
		: -1;
	const entries = cutoff >= 0 ? branch.slice(0, cutoff) : branch;

	return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
