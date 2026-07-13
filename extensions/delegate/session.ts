import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

export interface DelegateSession {
	token: string;
	filePath: string;
	cwd: string;
}

interface DelegateSessionMetadata {
	token: string;
	cwd: string;
	createdAt: string;
}

const SESSION_VERSION = 3;
const TOKEN_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sessionDir(): string {
	return path.join(getAgentDir(), ".delegate-sessions");
}

function sessionPaths(token: string): {
	filePath: string;
	metadataPath: string;
} {
	const dir = sessionDir();
	return {
		filePath: path.join(dir, `${token}.jsonl`),
		metadataPath: path.join(dir, `${token}.json`),
	};
}

function initialSessionJsonl(
	token: string,
	cwd: string,
	createdAt: string,
	snapshotJsonl?: string,
): string {
	if (!snapshotJsonl?.trim()) {
		return `${JSON.stringify({
			type: "session",
			version: SESSION_VERSION,
			id: token,
			timestamp: createdAt,
			cwd,
		})}\n`;
	}

	const lines = snapshotJsonl.split(/\r?\n/).filter((line) => line.trim());
	const parsed = lines.map((line) => JSON.parse(line) as unknown);
	const headerIndex = parsed.findIndex(
		(entry) =>
			entry !== null &&
			typeof entry === "object" &&
			(entry as { type?: unknown }).type === "session",
	);
	if (headerIndex < 0)
		throw new Error("Cannot create delegate session: snapshot has no header.");
	const sourceHeader = parsed[headerIndex] as Record<string, unknown>;
	parsed[headerIndex] = {
		...sourceHeader,
		id: token,
		timestamp: createdAt,
		cwd,
	};
	return `${parsed.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Create a durable child session and return its opaque continuation token. */
export function createDelegateSession(options: {
	cwd: string;
	snapshotJsonl?: string;
}): DelegateSession {
	const token = randomUUID();
	const createdAt = new Date().toISOString();
	const dir = sessionDir();
	const { filePath, metadataPath } = sessionPaths(token);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		writeFileSync(
			filePath,
			initialSessionJsonl(token, options.cwd, createdAt, options.snapshotJsonl),
			{ encoding: "utf8", mode: 0o600, flag: "wx" },
		);
		const metadata: DelegateSessionMetadata = {
			token,
			cwd: options.cwd,
			createdAt,
		};
		writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
	} catch (error) {
		rmSync(filePath, { force: true });
		rmSync(metadataPath, { force: true });
		throw error;
	}
	return { token, filePath, cwd: options.cwd };
}

/** Resolve a continuation token without allowing arbitrary path access. */
export function resolveDelegateSession(token: string): DelegateSession | null {
	if (!TOKEN_PATTERN.test(token)) return null;
	const { filePath, metadataPath } = sessionPaths(token);
	if (!existsSync(filePath) || !existsSync(metadataPath)) return null;
	try {
		const metadata = JSON.parse(
			readFileSync(metadataPath, "utf8"),
		) as Partial<DelegateSessionMetadata>;
		if (
			metadata.token !== token ||
			typeof metadata.cwd !== "string" ||
			!metadata.cwd
		)
			return null;
		return { token, filePath, cwd: metadata.cwd };
	} catch {
		return null;
	}
}

function containsToolCall(entry: unknown, toolCallId: string): boolean {
	if (!entry || typeof entry !== "object") return false;
	const message = (entry as { message?: unknown }).message;
	if (!message || typeof message !== "object") return false;
	const content = (message as { content?: unknown }).content;
	return (
		Array.isArray(content) &&
		content.some(
			(part) =>
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "toolCall" &&
				(part as { id?: unknown }).id === toolCallId,
		)
	);
}

export function buildSessionSnapshotJsonl(
	sessionManager: SessionSnapshotSource,
	options: { cwd?: string; excludeToolCallId?: string } = {},
): string | null {
	const sourceHeader = sessionManager.getHeader();
	if (!sourceHeader || typeof sourceHeader !== "object") return null;
	const header = options.cwd
		? { ...(sourceHeader as Record<string, unknown>), cwd: options.cwd }
		: sourceHeader;
	const branch = sessionManager.getBranch();
	const cutoff = options.excludeToolCallId
		? branch.findIndex((entry) =>
				containsToolCall(entry, options.excludeToolCallId as string),
			)
		: -1;
	const entries = cutoff >= 0 ? branch.slice(0, cutoff) : branch;

	return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
