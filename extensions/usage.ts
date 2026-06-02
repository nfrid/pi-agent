import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
	ExtensionAPI,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const STATUS_KEY = "usage";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;

type PiModel = NonNullable<ExtensionContext["model"]>;
type UsageWindow = {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
};
type UsageSnapshot = {
	limitId: string;
	limitName?: string;
	primary?: UsageWindow;
	secondary?: UsageWindow;
};
type UsageReport = { capturedAt: number; snapshots: UsageSnapshot[] };

type BackendPayload = {
	rate_limit?: unknown;
	additional_rate_limits?: unknown;
};
type AppServerResponse = {
	rateLimits?: unknown;
	rateLimitsByLimitId?: unknown;
};
type RpcResponse = {
	id?: unknown;
	result?: unknown;
	error?: { message?: unknown };
};

type PendingRpc = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

function isCodexModel(model: ExtensionContext["model"]): model is PiModel {
	return model?.provider === CODEX_PROVIDER_ID;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeKey(value: string | undefined): string | undefined {
	const normalized = value
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || undefined;
}

function normalizeBackendWindow(value: unknown): UsageWindow | undefined {
	const window = asRecord(value);
	if (!window) return undefined;
	const usedPercent = asNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	const limitSeconds = asNumber(window.limit_window_seconds);
	return {
		usedPercent,
		windowMinutes: limitSeconds ? Math.ceil(limitSeconds / 60) : undefined,
		resetsAt: asNumber(window.reset_at),
	};
}

function normalizeBackendSnapshot(
	limitId: string,
	limitName: string | undefined,
	rateLimit: unknown,
): UsageSnapshot | undefined {
	const details = asRecord(rateLimit);
	if (!details) return undefined;
	const primary = normalizeBackendWindow(details.primary_window);
	const secondary = normalizeBackendWindow(details.secondary_window);
	if (!primary && !secondary) return undefined;
	return { limitId, limitName, primary, secondary };
}

function normalizeBackendPayload(payload: BackendPayload): UsageReport {
	const snapshots: UsageSnapshot[] = [];
	const primary = normalizeBackendSnapshot(
		"codex",
		undefined,
		payload.rate_limit,
	);
	if (primary) snapshots.push(primary);

	const additional = Array.isArray(payload.additional_rate_limits)
		? payload.additional_rate_limits
		: [];
	for (const item of additional) {
		const limit = asRecord(item);
		if (!limit) continue;
		const limitId =
			asString(limit.metered_feature) ?? asString(limit.limit_name) ?? "codex";
		const snapshot = normalizeBackendSnapshot(
			limitId,
			asString(limit.limit_name),
			limit.rate_limit,
		);
		if (snapshot) snapshots.push(snapshot);
	}

	if (snapshots.length === 0) {
		throw new Error("Codex usage endpoint returned no rate-limit windows.");
	}
	return { capturedAt: Date.now(), snapshots };
}

function normalizeAppServerWindow(value: unknown): UsageWindow | undefined {
	const window = asRecord(value);
	if (!window) return undefined;
	const usedPercent = asNumber(window.usedPercent);
	if (usedPercent === undefined) return undefined;
	return {
		usedPercent,
		windowMinutes: asNumber(window.windowDurationMins),
		resetsAt: asNumber(window.resetsAt),
	};
}

function normalizeAppServerSnapshot(
	value: unknown,
	fallbackId: string,
): UsageSnapshot | undefined {
	const raw = asRecord(value);
	if (!raw) return undefined;
	const primary = normalizeAppServerWindow(raw.primary);
	const secondary = normalizeAppServerWindow(raw.secondary);
	if (!primary && !secondary) return undefined;
	return {
		limitId: asString(raw.limitId) ?? fallbackId,
		limitName: asString(raw.limitName),
		primary,
		secondary,
	};
}

function normalizeAppServerResponse(response: AppServerResponse): UsageReport {
	const snapshots: UsageSnapshot[] = [];
	const add = (value: unknown, fallbackId: string) => {
		const snapshot = normalizeAppServerSnapshot(value, fallbackId);
		if (!snapshot) return;
		const index = snapshots.findIndex(
			(item) => item.limitId === snapshot.limitId,
		);
		if (index >= 0) snapshots[index] = { ...snapshots[index], ...snapshot };
		else snapshots.push(snapshot);
	};

	add(response.rateLimits, "codex");
	const byId = asRecord(response.rateLimitsByLimitId);
	if (byId) {
		for (const [limitId, value] of Object.entries(byId)) add(value, limitId);
	}

	if (snapshots.length === 0) {
		throw new Error("Codex app-server returned no rate-limit windows.");
	}
	return { capturedAt: Date.now(), snapshots };
}

function modelKeys(model: PiModel): Set<string> {
	const keys = new Set<string>();
	for (const raw of [model.id, model.name]) {
		const key = normalizeKey(raw);
		if (!key) continue;
		keys.add(key);
		const codexIndex = key.indexOf("codex");
		if (codexIndex >= 0) keys.add(key.slice(codexIndex));
	}
	return keys;
}

function snapshotKeys(snapshot: UsageSnapshot): string[] {
	return [
		normalizeKey(snapshot.limitId),
		normalizeKey(snapshot.limitName),
	].filter((key): key is string => Boolean(key));
}

function isPrimarySnapshot(snapshot: UsageSnapshot): boolean {
	return snapshotKeys(snapshot).includes("codex");
}

function selectSnapshot(
	report: UsageReport,
	model: PiModel,
): UsageSnapshot | undefined {
	const keys = modelKeys(model);
	const exact = report.snapshots.find((snapshot) =>
		snapshotKeys(snapshot).some((key) => keys.has(key)),
	);
	return (
		exact ?? report.snapshots.find(isPrimarySnapshot) ?? report.snapshots[0]
	);
}

function usageToColor(percent: number): ThemeColor {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	if (percent > 50) return "success";
	return "dim";
}

function formatUsage(report: UsageReport, ctx: ExtensionContext): string {
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

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const normalized = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

async function resolvePiCodexHeaders(
	ctx: ExtensionContext,
): Promise<Record<string, string> | undefined> {
	const candidates: PiModel[] = [];
	const seen = new Set<string>();
	const add = (model: ExtensionContext["model"]) => {
		if (!isCodexModel(model)) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};

	add(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable()) add(model);
	for (const model of ctx.modelRegistry.getAll()) add(model);

	for (const model of candidates) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) continue;
		const headers = { ...(auth.headers ?? {}) };
		if (!hasHeader(headers, "Authorization") && auth.apiKey) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}
		if (!hasHeader(headers, "User-Agent")) headers["User-Agent"] = "pi-usage";
		if (hasHeader(headers, "Authorization")) return headers;
	}

	return undefined;
}

async function queryViaPiAuth(ctx: ExtensionContext): Promise<UsageReport> {
	const headers = await resolvePiCodexHeaders(ctx);
	if (!headers) throw new Error("No Pi Codex auth available.");

	const response = await fetchWithTimeout(CODEX_USAGE_URL, { headers });
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Codex usage endpoint returned ${response.status}: ${text.slice(0, 300)}`,
		);
	}
	return normalizeBackendPayload(JSON.parse(text) as BackendPayload);
}

class CodexAppServerClient {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRpc>();

	async start(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;
			const timer = setTimeout(
				() => reject(new Error("Timed out starting codex app-server.")),
				TIMEOUT_MS,
			);
			child.once("spawn", () => {
				clearTimeout(timer);
				resolve();
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", () => {
				this.rejectAll(new Error("codex app-server exited."));
			});
			createInterface({ input: child.stdout }).on("line", (line) =>
				this.handleLine(line),
			);
		});
	}

	request(method: string, params?: unknown): Promise<unknown> {
		const child = this.child;
		if (!child?.stdin.writable)
			throw new Error("codex app-server is not running.");
		const id = this.nextId++;
		const payload =
			params === undefined ? { method, id } : { method, id, params };
		const response = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${method}.`));
			}, TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
		child.stdin.write(`${JSON.stringify(payload)}\n`);
		return response;
	}

	notify(method: string): void {
		this.child?.stdin.write(`${JSON.stringify({ method })}\n`);
	}

	dispose(): void {
		this.rejectAll(new Error("codex app-server disposed."));
		this.child?.stdin.end();
		this.child?.kill();
		this.child = undefined;
	}

	private handleLine(line: string): void {
		let parsed: RpcResponse;
		try {
			parsed = JSON.parse(line) as RpcResponse;
		} catch {
			return;
		}
		if (typeof parsed.id !== "number") return;
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);
		if (parsed.error) {
			pending.reject(
				new Error(String(parsed.error.message ?? "unknown error")),
			);
		} else {
			pending.resolve(parsed.result);
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

async function queryViaCodexAppServer(): Promise<UsageReport> {
	const client = new CodexAppServerClient();
	try {
		await client.start();
		await client.request("initialize", {
			clientInfo: { name: "pi_usage", title: "Pi Usage", version: "0.1.0" },
			capabilities: {
				experimentalApi: false,
				requestAttestation: false,
				optOutNotificationMethods: [],
			},
		});
		client.notify("initialized");
		const result = await client.request("account/rateLimits/read");
		return normalizeAppServerResponse(result as AppServerResponse);
	} finally {
		client.dispose();
	}
}

async function queryUsage(ctx: ExtensionContext): Promise<UsageReport> {
	try {
		return await queryViaPiAuth(ctx);
	} catch {
		return queryViaCodexAppServer();
	}
}

export default function usage(pi: ExtensionAPI) {
	let cache: UsageReport | undefined;
	let refreshPromise: Promise<void> | undefined;
	let timer: NodeJS.Timeout | undefined;

	const clear = (ctx: ExtensionContext) =>
		ctx.ui.setStatus(STATUS_KEY, undefined);

	const refresh = (ctx: ExtensionContext, force = false) => {
		if (!isCodexModel(ctx.model)) {
			clear(ctx);
			return;
		}
		if (refreshPromise) return;
		if (
			!force &&
			cache &&
			Date.now() - cache.capturedAt < REFRESH_INTERVAL_MS
		) {
			ctx.ui.setStatus(STATUS_KEY, formatUsage(cache, ctx));
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "loading…"));
		refreshPromise = queryUsage(ctx)
			.then((report) => {
				cache = report;
				if (isCodexModel(ctx.model)) {
					ctx.ui.setStatus(STATUS_KEY, formatUsage(report, ctx));
				}
			})
			.catch(() => {
				if (isCodexModel(ctx.model))
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "usage error"));
			})
			.finally(() => {
				refreshPromise = undefined;
			});
	};

	pi.on("session_start", (_event, ctx) => {
		refresh(ctx, true);
		if (timer) clearInterval(timer);
		timer = setInterval(() => refresh(ctx), REFRESH_INTERVAL_MS);
		timer.unref?.();
	});

	pi.on("model_select", (_event, ctx) => refresh(ctx));
	pi.on("turn_end", (_event, ctx) => refresh(ctx, true));
	pi.on("agent_end", (_event, ctx) => refresh(ctx, true));

	pi.registerCommand("usage", {
		description: "Refresh Codex 5h / weekly usage in the footer",
		handler: async (_args, ctx) => {
			refresh(ctx, true);
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clear(ctx);
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
