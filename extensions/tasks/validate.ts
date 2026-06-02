import { normalizeId } from "./normalize";
import { getState } from "./state";

export function validateDeps(id: string, deps: string[]): string | undefined {
	const unique = [
		...new Set(
			deps.map(normalizeId).filter((dep): dep is string => Boolean(dep)),
		),
	];
	if (unique.includes(id)) return "task cannot depend on itself";
	const ids = new Set(getState().tasks.map((task) => task.id));
	const missing = unique.filter((dep) => !ids.has(dep));
	if (missing.length) return `unknown dependencies: ${missing.join(", ")}`;
	return undefined;
}
