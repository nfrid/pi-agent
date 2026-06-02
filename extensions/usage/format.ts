import type {
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { clampPercent } from "./coerce";
import { selectSnapshot } from "./snapshot";
import type { UsageReport } from "./types";

function usageToColor(percent: number): ThemeColor {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	if (percent > 50) return "success";
	return "dim";
}

export function formatUsage(
	report: UsageReport,
	ctx: ExtensionContext,
): string {
	const theme = ctx.ui.theme;
	const unavailable = theme.fg("error", "usage unavailable");
	const model = ctx.model;
	if (!model) return unavailable;
	const snapshot = selectSnapshot(report, model);
	if (!snapshot) return unavailable;

	const parts: string[] = [];
	if (snapshot.primary) {
		const percent = Math.round(clampPercent(snapshot.primary.usedPercent));
		parts.push(theme.fg(usageToColor(percent), `5h ${percent}%`));
	}
	if (snapshot.secondary) {
		const percent = Math.round(clampPercent(snapshot.secondary.usedPercent));
		parts.push(theme.fg(usageToColor(percent), `wk ${percent}%`));
	}
	return parts.join(" ");
}
