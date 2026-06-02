export function normalizeId(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	return /^T\d+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

export function normalizeIds(values: readonly unknown[] | undefined): string[] {
	return [
		...new Set(
			(values ?? []).map(normalizeId).filter((id): id is string => Boolean(id)),
		),
	];
}
