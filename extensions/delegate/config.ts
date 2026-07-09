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
const PROJECT_CONFIG_DIR = ".pi";

export interface DelegateConfig {
	defaultEffort?: DelegateEffort;
	effortProfiles?: Partial<Record<DelegateEffort, DelegateEffortProfile>>;
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
	const provider =
		typeof record.provider === "string" ? record.provider.trim() : "";
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!provider || !id || !isThinking(record.thinking)) return undefined;
	return { provider, id, thinking: record.thinking };
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
		if (isEffort(record.defaultEffort))
			config.defaultEffort = record.defaultEffort;
		const profiles = parseProfiles(record.effortProfiles);
		if (profiles) config.effortProfiles = profiles;
		return config;
	} catch {
		return {};
	}
}

function mergeProfiles(
	base: Partial<Record<DelegateEffort, DelegateEffortProfile>> | undefined,
	override: Partial<Record<DelegateEffort, DelegateEffortProfile>> | undefined,
): Partial<Record<DelegateEffort, DelegateEffortProfile>> | undefined {
	const merged = { ...(base ?? {}), ...(override ?? {}) };
	return Object.keys(merged).length > 0 ? merged : undefined;
}

export function loadDelegateConfig(cwd: string): DelegateConfig {
	const agentDir = getAgentDir();
	const globalConfig = readConfigFile(path.join(agentDir, "settings.json"));
	const projectConfig = readConfigFile(
		path.join(cwd, PROJECT_CONFIG_DIR, "settings.json"),
	);
	const config: DelegateConfig = { ...globalConfig, ...projectConfig };
	const profiles = mergeProfiles(
		globalConfig.effortProfiles,
		projectConfig.effortProfiles,
	);
	if (profiles) config.effortProfiles = profiles;
	else delete config.effortProfiles;
	return config;
}

export function resolveEffort(
	requested: unknown,
	config: DelegateConfig,
): {
	selected?: DelegateEffort;
	profile?: DelegateEffortProfile;
	warning?: string;
} {
	const selected = isEffort(requested) ? requested : config.defaultEffort;
	if (!selected) return {};
	const profile = config.effortProfiles?.[selected];
	if (profile) return { selected, profile };
	return {
		selected,
		warning: `Effort "${selected}" has no configured profile; using child Pi defaults.`,
	};
}
