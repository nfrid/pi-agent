import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	DelegateEffort,
	DelegateEffortProfile,
	ThinkingLevel,
} from "./types";

export const EFFORT_LEVELS = ["fast", "balanced", "deep"] as const;
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
const SETTINGS_KEY = "delegate";

export interface DelegateConfig {
	provider?: string;
	defaultEffort?: DelegateEffort;
	effortProfiles?: Partial<Record<DelegateEffort, DelegateEffortProfile>>;
	error?: string;
}

function isEffort(value: unknown): value is DelegateEffort {
	return (
		typeof value === "string" && EFFORT_LEVELS.includes(value as DelegateEffort)
	);
}

function isThinking(value: unknown): value is ThinkingLevel {
	return (
		typeof value === "string" &&
		THINKING_LEVELS.includes(value as ThinkingLevel)
	);
}

function parseProfile(raw: unknown): DelegateEffortProfile | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const model = typeof record.model === "string" ? record.model.trim() : "";
	if (!model || !isThinking(record.thinking)) return undefined;
	return { model, thinking: record.thinking };
}

function parseProfiles(
	raw: unknown,
): Partial<Record<DelegateEffort, DelegateEffortProfile>> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const profiles: Partial<Record<DelegateEffort, DelegateEffortProfile>> = {};
	for (const effort of EFFORT_LEVELS) {
		const profile = parseProfile((raw as Record<string, unknown>)[effort]);
		if (profile) profiles[effort] = profile;
	}
	return Object.keys(profiles).length > 0 ? profiles : undefined;
}

function readConfigFile(settingsPath: string): DelegateConfig {
	if (!existsSync(settingsPath)) return {};
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
			string,
			unknown
		>;
		const nested = raw[SETTINGS_KEY];
		if (!nested || typeof nested !== "object" || Array.isArray(nested))
			return {};
		const record = nested as Record<string, unknown>;
		const config: DelegateConfig = {};
		if (typeof record.provider === "string" && record.provider.trim())
			config.provider = record.provider.trim();
		if (isEffort(record.defaultEffort))
			config.defaultEffort = record.defaultEffort;
		const profiles = parseProfiles(record.effortProfiles);
		if (profiles) config.effortProfiles = profiles;
		return config;
	} catch {
		return {
			error: `Could not parse delegate configuration at ${settingsPath}.`,
		};
	}
}

export function loadDelegateConfig(_cwd: string): DelegateConfig {
	// Model routing is user-owned. Do not let a repository silently choose which
	// subscription/provider delegated work consumes.
	return readConfigFile(path.join(getAgentDir(), "settings.json"));
}

export function resolveEffort(
	requested: unknown,
	config: DelegateConfig,
): {
	selected?: DelegateEffort;
	provider?: string;
	profile?: DelegateEffortProfile;
	error?: string;
} {
	if (config.error) return { error: config.error };
	const selected = isEffort(requested) ? requested : config.defaultEffort;
	if (!selected) return {};
	const profile = config.effortProfiles?.[selected];
	if (!profile || !config.provider) {
		return {
			selected,
			error: `Delegate effort "${selected}" is not fully configured. Set delegate.provider and delegate.effortProfiles.${selected}.`,
		};
	}
	return { selected, provider: config.provider, profile };
}
