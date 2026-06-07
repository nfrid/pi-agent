import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type FooterInfoRenderer = {
	priority?: number;
	render(theme: Theme, ctx: ExtensionContext): string;
};

type FooterAdditionalInfoAPI = {
	set(key: string, renderer: FooterInfoRenderer | undefined): void;
	subscribe(callback: () => void): () => void;
	render(theme: Theme, ctx: ExtensionContext): string[];
};

declare global {
	// eslint-disable-next-line no-var
	var piFooterAdditionalInfo: FooterAdditionalInfoAPI | undefined;
}

function contextColor(percent: number | undefined): ThemeColor {
	if (percent === undefined) return "dim";
	if (percent >= 80) return "error";
	if (percent >= 50) return "warning";
	return "dim";
}

function thinkingToThemeColor(thinking: "off" | ThinkingLevel): ThemeColor {
	return ("thinking" +
		thinking.charAt(0).toUpperCase() +
		thinking.slice(1)) as ThemeColor;
}

function joinParts(theme: Theme, width: number, parts: string[]): string {
	const sep = theme.fg("dim", " • ");
	let line = parts.filter(Boolean).join(sep);
	if (visibleWidth(line) <= width) return line;

	// First squeeze separators, then truncate.
	line = parts.filter(Boolean).join(" • ");
	return truncateToWidth(line, width, "…");
}

export default function (pi: ExtensionAPI) {
	let requestRender = () => {};

	const refresh = () => requestRender();

	pi.on("session_start", (_event, ctx) => {
		const mode = "mode" in ctx ? ctx.mode : "tui";
		if (mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			return {
				dispose() {
					requestRender = () => {};
				},
				invalidate() {},
				render(width: number): string[] {
					const leadingSpaceWidth = 1;
					const minGapWidth = 1;
					const contextUsage = ctx.getContextUsage();
					const contextWindow = ctx.model?.contextWindow;
					const contextPercent =
						contextUsage && contextWindow && contextUsage.tokens !== null
							? Math.round((contextUsage.tokens / contextWindow) * 100)
							: undefined;

					const model = ctx.model?.id ?? "no-model";
					const thinking = pi.getThinkingLevel();
					const contextInfo =
						contextPercent !== undefined
							? theme.fg(contextColor(contextPercent), `${contextPercent}%`)
							: "";

					const statuses = [...footerData.getExtensionStatuses().values()];
					const left = [
						theme.fg("accent", model),
						theme.fg(thinkingToThemeColor(thinking), thinking),
						...statuses,
					];

					if (!contextInfo) {
						return [` ${joinParts(theme, width - leadingSpaceWidth, left)}`];
					}

					const contextWidth = visibleWidth(contextInfo);
					const leftWidth = Math.max(
						0,
						width - leadingSpaceWidth - minGapWidth - contextWidth,
					);
					const leftText =
						leftWidth > 0 ? joinParts(theme, leftWidth, left) : "";
					const gapWidth = Math.max(
						0,
						width - leadingSpaceWidth - visibleWidth(leftText) - contextWidth,
					);

					return [` ${leftText}${" ".repeat(gapWidth)}${contextInfo}`];
				},
			};
		});
	});

	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);
	pi.on("agent_end", refresh);
	pi.on("turn_end", refresh);
}
