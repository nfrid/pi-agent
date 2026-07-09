import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EFFORT_LEVELS, loadDelegateConfig, resolveEffort } from "./config";
import { renderDelegateCall, renderDelegateResult } from "./render";
import { mapWithConcurrency, runDelegate } from "./runner";
import { buildSessionSnapshotJsonl } from "./session";
import {
	createRun,
	type DelegateDetails,
	type DelegatedRun,
	getFinalAssistantText,
	isRunError,
} from "./types";

const MAX_PARALLEL_TASKS = 6;
const MAX_CONCURRENCY = 3;
const OUTPUT_CAP = 50 * 1024;

const EffortSchema = StringEnum(EFFORT_LEVELS, {
	description:
		"Optional child model profile. Use fast for easy/narrow tasks, balanced for normal work, deep for ambiguous/risky review or debugging.",
});

const ContextSchema = StringEnum(["branch", "fresh"] as const, {
	description:
		"Optional context mode. Use branch to include the current session branch, or fresh to start without parent conversation history. Defaults to branch.",
});

const TaskItem = Type.Object({
	task: Type.String({
		description: "Focused task to delegate to a child Pi process",
	}),
	cwd: Type.Optional(
		Type.String({
			description: "Optional working directory for this child process",
		}),
	),
	effort: Type.Optional(EffortSchema),
	context: Type.Optional(ContextSchema),
});

const DelegateParams = Type.Object({
	task: Type.Optional(
		Type.String({ description: "Focused task to delegate (single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Parallel delegated tasks" }),
	),
	effort: Type.Optional(EffortSchema),
	context: Type.Optional(ContextSchema),
	mode: Type.Optional(
		StringEnum(["auto", "single", "parallel"] as const, {
			description:
				"Optional mode hint. Usually omit; task means single, tasks means parallel.",
			default: "auto",
		}),
	),
});

function makeDetails(
	mode: DelegateDetails["mode"],
	runs: DelegatedRun[],
): DelegateDetails {
	return { mode, runs };
}

function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let out = text.slice(0, maxBytes);
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
	return `${out}\n\n[Output truncated for parent context; full output is preserved in tool details.]`;
}

function resultText(run: DelegatedRun): string {
	const warning = run.effort?.warning
		? `Delegate warning: ${run.effort.warning}\n\n`
		: "";
	const final = getFinalAssistantText(run.messages).trim();
	if (final) return `${warning}${final}`;
	return `${warning}${run.errorMessage?.trim() || run.stderr.trim() || "(no output)"}`;
}

function invalidParams(message: string): {
	content: Array<{ type: "text"; text: string }>;
	details: DelegateDetails;
	isError: true;
} {
	return {
		content: [{ type: "text", text: message }],
		details: makeDetails("single", []),
		isError: true,
	};
}

export default function delegate(pi: ExtensionAPI) {
	if (process.env.PI_DELEGATE_CHILD === "1") return;

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate focused work to one or more child Pi processes with isolated context windows.",
			"Use this when exploration, review, validation, or parallel option checks would add noisy tool output to the main conversation.",
			"By default each child starts from the current active session branch and returns a compact decision-useful report; pass context: fresh to omit parent conversation history.",
		].join(" "),
		promptSnippet:
			"Delegate focused exploration, review, validation, or option checks to child Pi processes.",
		promptGuidelines: [
			"Use delegate for context-heavy investigation, review, validation, debugging, planning, or parallel option checks when keeping noisy tool output out of the main context is valuable.",
			"Do not use delegate for trivial edits or questions you can answer directly with a small number of tool calls.",
			"When using delegate, give each child a narrow task with clear boundaries and ask for concrete evidence anchors when they matter.",
		],
		parameters: DelegateParams,
		renderCall: renderDelegateCall,
		renderResult: renderDelegateResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = loadDelegateConfig(ctx.cwd);
			let snapshot: string | null | undefined;
			const getSnapshot = () => {
				if (snapshot !== undefined) return snapshot;
				snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
				return snapshot;
			};

			const hasSingle =
				typeof params.task === "string" && params.task.trim().length > 0;
			const hasParallel =
				Array.isArray(params.tasks) && params.tasks.length > 0;
			if (hasSingle === hasParallel) {
				return invalidParams(
					"Provide exactly one delegation mode: either task for a single child, or tasks for parallel children.",
				);
			}

			if (hasSingle && typeof params.task === "string") {
				const task = params.task.trim();
				const effort = resolveEffort(params.effort, config);
				const context = params.context === "fresh" ? "fresh" : "branch";
				const runSnapshot = context === "branch" ? getSnapshot() : undefined;
				if (context === "branch" && !runSnapshot)
					return invalidParams(
						"Cannot delegate: failed to snapshot current session branch.",
					);
				const run = await runDelegate({
					cwd: ctx.cwd,
					task,
					snapshotJsonl: runSnapshot || undefined,
					effort,
					signal,
					onUpdate,
					makeDetails: (runs) => makeDetails("single", runs),
				});
				const text = resultText(run);
				return {
					content: [
						{
							type: "text" as const,
							text: isRunError(run) ? `Delegated task failed: ${text}` : text,
						},
					],
					details: makeDetails("single", [run]),
					...(isRunError(run) ? { isError: true as const } : {}),
				};
			}

			const tasks = (params.tasks ?? [])
				.map((item) => ({ ...item, task: item.task.trim() }))
				.filter((item) => item.task);
			if (tasks.length === 0)
				return invalidParams(
					"Parallel delegation requires at least one non-empty task.",
				);
			if (tasks.length > MAX_PARALLEL_TASKS) {
				return invalidParams(
					`Too many delegated tasks (${tasks.length}). Maximum is ${MAX_PARALLEL_TASKS}.`,
				);
			}

			const efforts = tasks.map((item) =>
				resolveEffort(item.effort ?? params.effort, config),
			);
			const liveRuns = tasks.map((item, index) =>
				createRun(item.task, efforts[index]),
			);
			const emitParallelUpdate = () => {
				const done = liveRuns.filter((run) => run.exitCode !== -1).length;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Delegated tasks: ${done}/${liveRuns.length} complete`,
						},
					],
					details: makeDetails("parallel", [...liveRuns]),
				});
			};

			const contexts = tasks.map((item) =>
				item.context === "fresh" || params.context === "fresh"
					? "fresh"
					: "branch",
			);
			if (contexts.includes("branch") && !getSnapshot())
				return invalidParams(
					"Cannot delegate: failed to snapshot current session branch.",
				);

			const runs = await mapWithConcurrency(
				tasks,
				MAX_CONCURRENCY,
				async (item, index) => {
					const run = await runDelegate({
						cwd: item.cwd ?? ctx.cwd,
						task: item.task,
						snapshotJsonl:
							contexts[index] === "branch"
								? getSnapshot() || undefined
								: undefined,
						effort: efforts[index],
						signal,
						onUpdate: (partial) => {
							const current = partial.details?.runs?.[0];
							if (current) liveRuns[index] = current;
							emitParallelUpdate();
						},
						makeDetails: (runs) => makeDetails("parallel", runs),
					});
					liveRuns[index] = run;
					emitParallelUpdate();
					return run;
				},
			);

			const succeeded = runs.filter((run) => !isRunError(run)).length;
			const sections = runs.map((run, index) => {
				const state = isRunError(run) ? "failed" : "completed";
				return `## Task ${index + 1}: ${state}\n\n${truncateBytes(resultText(run), OUTPUT_CAP)}`;
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Delegated tasks: ${succeeded}/${runs.length} succeeded\n\n${sections.join("\n\n---\n\n")}`,
					},
				],
				details: makeDetails("parallel", runs),
				...(succeeded === 0 ? { isError: true as const } : {}),
			};
		},
	});
}
