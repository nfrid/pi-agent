import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processJsonLine } from "./events";
import { buildDelegatePrompt } from "./prompt";
import {
	createRun,
	type DelegateDetails,
	type DelegatedRun,
	type DelegateEffortState,
	getFinalAssistantText,
} from "./types";

const SIGKILL_TIMEOUT_MS = 5000;

type OnUpdate = (partial: {
	content: Array<{ type: "text"; text: string }>;
	details: DelegateDetails;
}) => void;

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
	const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
	const isBun = /[\\/]bun(?:\.exe)?$/i.test(process.execPath);
	const script = process.argv[1];
	if ((isNode || isBun) && script && fs.existsSync(script)) {
		return { command: process.execPath, prefixArgs: [script] };
	}
	return { command: "pi", prefixArgs: [] };
}

function writeSnapshot(snapshotJsonl: string): {
	dir: string;
	filePath: string;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-"));
	const filePath = path.join(dir, "delegate.jsonl");
	fs.writeFileSync(filePath, snapshotJsonl, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function cleanup(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
}

function progressText(run: DelegatedRun): string {
	const final = getFinalAssistantText(run.messages).trim();
	if (final) return final;
	if (run.errorMessage?.trim()) return run.errorMessage.trim();
	const recent = run.activities.slice(-8);
	if (recent.length > 0) {
		return recent
			.map((activity) => {
				const icon =
					activity.status === "running"
						? "…"
						: activity.status === "error"
							? "×"
							: "✓";
				return `${icon} ${activity.label}${activity.latestText ? `\n${activity.latestText}` : ""}`;
			})
			.join("\n");
	}
	return "(running...)";
}

export interface RunDelegateOptions {
	cwd: string;
	task: string;
	snapshotJsonl?: string;
	effort?: DelegateEffortState;
	signal?: AbortSignal;
	onUpdate?: OnUpdate;
	makeDetails: (runs: DelegatedRun[]) => DelegateDetails;
}

export async function runDelegate(
	options: RunDelegateOptions,
): Promise<DelegatedRun> {
	const run = createRun(options.task, options.effort);
	let tmp: { dir: string; filePath: string } | undefined;
	let wasAborted = false;

	const emitUpdate = () => {
		options.onUpdate?.({
			content: [{ type: "text", text: progressText(run) }],
			details: options.makeDetails([run]),
		});
	};

	try {
		if (options.snapshotJsonl) tmp = writeSnapshot(options.snapshotJsonl);
		const { command, prefixArgs } = resolvePiSpawn();
		const args = ["--mode", "json", "-p"];
		if (tmp) args.push("--session", tmp.filePath);
		if (options.effort?.profile) {
			args.push("--provider", options.effort.profile.provider);
			args.push("--model", options.effort.profile.id);
			args.push("--thinking", options.effort.profile.thinking);
		}
		args.push(buildDelegatePrompt(options.task));

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(command, [...prefixArgs, ...args], {
				cwd: options.cwd,
				env: { ...process.env, PI_DELEGATE_CHILD: "1" },
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let closed = false;
			let settled = false;
			let abortHandler: (() => void) | undefined;

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (options.signal && abortHandler)
					options.signal.removeEventListener("abort", abortHandler);
				resolve(code);
			};

			const terminate = () => {
				wasAborted = true;
				if (process.platform === "win32" && proc.pid) {
					spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
						stdio: "ignore",
					}).unref();
					return;
				}
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!closed) proc.kill("SIGKILL");
				}, SIGKILL_TIMEOUT_MS).unref();
			};

			const processLine = (line: string) => {
				if (processJsonLine(line, run)) emitUpdate();
			};

			proc.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				run.stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				closed = true;
				if (buffer.trim()) processLine(buffer);
				finish(code ?? 0);
			});

			proc.on("error", (error) => {
				run.stderr += error.message;
				finish(1);
			});

			abortHandler = terminate;
			if (options.signal?.aborted) terminate();
			else options.signal?.addEventListener("abort", terminate, { once: true });
		});

		run.exitCode = wasAborted ? 130 : exitCode;
		if (wasAborted) {
			run.stopReason = "aborted";
			run.errorMessage = "Delegated task was aborted.";
		} else if (exitCode !== 0 && !run.errorMessage) {
			run.stopReason = "error";
			run.errorMessage =
				run.stderr.trim() || `Child Pi exited with code ${exitCode}.`;
		}
		return run;
	} finally {
		if (tmp) cleanup(tmp.dir);
	}
}

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const results = new Array<TOut>(items.length);
	let next = 0;
	const workers = new Array(Math.max(1, Math.min(concurrency, items.length)))
		.fill(null)
		.map(async () => {
			while (true) {
				const index = next++;
				if (index >= items.length) return;
				results[index] = await fn(items[index], index);
			}
		});
	await Promise.all(workers);
	return results;
}
