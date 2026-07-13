import type { Message } from "@earendil-works/pi-ai";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	contextTokens: number;
	cost: number;
	turns: number;
}

export interface DelegatedActivity {
	id?: string;
	type: "thinking" | "tool";
	label: string;
	status: "running" | "completed" | "error";
	latestText?: string;
}

export type DelegateEffort = "economy" | "balanced" | "deep";
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export interface DelegateEffortProfile {
	model: string;
	thinking: ThinkingLevel;
}

export interface DelegateEffortState {
	selected?: DelegateEffort;
	provider?: string;
	profile?: DelegateEffortProfile;
	warning?: string;
}

export type DelegateContext = "branch" | "fresh" | "continuation";
export type DelegateRunState =
	| "queued"
	| "running"
	| "success"
	| "error"
	| "aborted"
	| "timed-out";

export interface DelegateRunMetadata {
	cwd?: string;
	context?: DelegateContext;
	contextNote?: string;
	allowWrites?: boolean;
	scope?: string[];
	continuation?: string;
	warnings?: string[];
}

export interface DelegatedRun extends DelegateRunMetadata {
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	effort?: DelegateEffortState;
	activities: DelegatedActivity[];
	state?: DelegateRunState;
	queuedAt?: number;
	startedAt?: number;
	finishedAt?: number;
}

export interface DelegateDetails {
	mode: "single" | "parallel";
	runs: DelegatedRun[];
}

export interface DelegateTask {
	task: string;
	cwd?: string;
}

export function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		contextTokens: 0,
		cost: 0,
		turns: 0,
	};
}

export function createRun(
	task: string,
	effort?: DelegateEffortState,
	metadata: DelegateRunMetadata = {},
): DelegatedRun {
	return {
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		effort,
		activities: [],
		state: "queued",
		queuedAt: Date.now(),
		...metadata,
	};
}

export function getRunState(run: DelegatedRun): DelegateRunState {
	if (run.state) return run.state;
	if (run.exitCode === -1) return "running";
	if (run.stopReason === "aborted") return "aborted";
	if (run.exitCode === 124) return "timed-out";
	return isRunError(run) ? "error" : "success";
}

export function isRunError(run: DelegatedRun): boolean {
	if (run.exitCode === -1) return false;
	if (run.stopReason === "error" || run.stopReason === "aborted") return true;
	return run.exitCode !== 0 || !getFinalAssistantText(run.messages).trim();
}

export function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part) => part.type === "text" && part.text.trim())
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}
