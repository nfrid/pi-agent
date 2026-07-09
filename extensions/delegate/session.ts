interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

export function buildSessionSnapshotJsonl(
	sessionManager: SessionSnapshotSource,
): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;

	const lines = [JSON.stringify(header)];
	for (const entry of sessionManager.getBranch()) {
		lines.push(JSON.stringify(entry));
	}
	return `${lines.join("\n")}\n`;
}
