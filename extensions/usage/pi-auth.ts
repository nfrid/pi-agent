import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasHeader } from "./coerce";
import { CODEX_USAGE_URL } from "./constants";
import { fetchWithTimeout } from "./http";
import { isCodexModel } from "./model";
import { normalizeBackendPayload } from "./normalize";
import type { BackendPayload, PiModel, UsageReport } from "./types";

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

export async function queryViaPiAuth(
	ctx: ExtensionContext,
): Promise<UsageReport> {
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
