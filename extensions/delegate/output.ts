export function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffix =
		"\n\n[Output truncated for parent context; full output is preserved in tool details.]";
	const contentBudget = Math.max(
		0,
		maxBytes - Buffer.byteLength(suffix, "utf8"),
	);
	let out = text.slice(0, contentBudget);
	while (Buffer.byteLength(out, "utf8") > contentBudget) out = out.slice(0, -1);
	return out + suffix;
}
