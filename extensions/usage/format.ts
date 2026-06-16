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

function resetTimeToMs(resetsAt: number): number {
	return resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000;
}

function formatDurationLeft(resetsAt: number, now = Date.now()): string {
	const totalMinutes = Math.max(
		0,
		Math.ceil((resetTimeToMs(resetsAt) - now) / 60_000),
	);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return `${days}d ${hours > 0 ? `${hours}h` : ""}`;
	if (hours > 0) return `${hours}h ${minutes > 0 ? `${minutes}m` : ""}`;
	return `${minutes}m`;
}

function formatUsagePart(
	label: string,
	percent: number,
	resetsAt: number | undefined,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const reset = resetsAt ? ` ^${formatDurationLeft(resetsAt)}` : "";
	return `${theme.fg("dim", label)} ${theme.fg(
		usageToColor(percent),
		`${percent}%`,
	)}${theme.italic(theme.fg("muted", reset))}`;
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
		parts.push(
			formatUsagePart("5h", percent, snapshot.primary.resetsAt, theme),
		);
	}
	if (snapshot.secondary) {
		const percent = Math.round(clampPercent(snapshot.secondary.usedPercent));
		parts.push(
			formatUsagePart("wk", percent, snapshot.secondary.resetsAt, theme),
		);
	}
	return parts.join(theme.fg("dim", " ⋅ "));
}
