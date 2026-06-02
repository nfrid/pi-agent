export function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeKey(value: string | undefined): string | undefined {
	const normalized = value
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || undefined;
}

export function hasHeader(
	headers: Record<string, string>,
	name: string,
): boolean {
	const normalized = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}
