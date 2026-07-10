import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EFFORT_LEVELS, loadDelegateConfig, resolveEffort } from "./config";
import { truncateBytes } from "./output";
import { renderDelegateCall, renderDelegateResult } from "./render";
import { mapWithConcurrency, runDelegate } from "./runner";
import { buildSessionSnapshotJsonl } from "./session";
import {
	createRun,
	type DelegateDetails,
	type DelegatedRun,
	type DelegateEffortState,
	getFinalAssistantText,
	isRunError,
} from "./types";

const MAX_PARALLEL_TASKS = 6;
const MAX_CONCURRENCY = 3;
const OUTPUT_CAP = 50 * 1024;

const EffortSchema = StringEnum(EFFORT_LEVELS, {
	description:
		"Optional child model profile. fast favors speed and economy for focused or routine work; balanced provides stronger general-purpose reasoning at moderate cost; deep spends more time and compute on demanding work where additional scrutiny may help. Choose based on the task.",
});

const ContextSchema = StringEnum(["branch", "fresh"] as const, {
	description:
		"Optional context mode. branch includes the current session branch; fresh starts without parent conversation history. Defaults to branch.",
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
		Type.String({ description: "Focused task to delegate to one child" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Focused tasks to delegate in parallel",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Optional working directory for a single child",
		}),
	),
	effort: Type.Optional(EffortSchema),
	context: Type.Optional(ContextSchema),
});

function makeDetails(
	mode: DelegateDetails["mode"],
	runs: DelegatedRun[],
): DelegateDetails {
	return { mode, runs };
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

function effortFor(
	requested: unknown,
	config: ReturnType<typeof loadDelegateConfig>,
): { effort?: DelegateEffortState; error?: string } {
	const resolved = resolveEffort(requested, config);
	if (resolved.error) return { error: resolved.error };
	return { effort: resolved };
}

export default function delegate(pi: ExtensionAPI) {
	// Recursive fan-out wastes tokens and is especially unreliable with small models.
	if (process.env.PI_DELEGATE_CHILD === "1") return;

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate focused work to one or more child Pi processes with isolated context windows.",
			"Use this for exploration, review, validation, debugging, planning, or parallel option checks that would add noisy tool output to the main conversation.",
			"Children receive the current session branch by default; pass context: fresh to omit it. Delegate is unavailable to children to prevent recursive fan-out.",
			"Children share the selected working directory. They are read-only by default; explicitly authorize changes only for a deliberate implementation task. Parallel tasks should not mutate overlapping files.",
		].join(" "),
		promptSnippet:
			"Delegate focused exploration, review, validation, implementation, or option checks to child Pi processes.",
		promptGuidelines: [
			"Use delegate for context-heavy investigation, review, validation, debugging, planning, or parallel option checks when keeping noisy tool output out of the main context is valuable.",
			"Do not use delegate for trivial edits or questions answerable with a small number of tool calls.",
			"Delegate children are read-only unless the task explicitly authorizes filesystem changes. Do not give parallel children overlapping mutation scopes.",
			"Delegate cannot be called by child processes; do not ask a delegated child to delegate further.",
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
			if (hasSingle === hasParallel)
				return invalidParams(
					"Provide exactly one delegation mode: task for one child, or tasks for parallel children.",
				);

			if (hasSingle && typeof params.task === "string") {
				const task = params.task.trim();
				const resolved = effortFor(params.effort, config);
				if (resolved.error) return invalidParams(resolved.error);
				const context = params.context ?? "branch";
				const runSnapshot = context === "branch" ? getSnapshot() : undefined;
				if (context === "branch" && !runSnapshot)
					return invalidParams(
						"Cannot delegate: failed to snapshot current session branch.",
					);
				const run = await runDelegate({
					cwd: params.cwd ?? ctx.cwd,
					task,
					snapshotJsonl: runSnapshot ?? undefined,
					effort: resolved.effort,
					signal,
					onUpdate,
					makeDetails: (runs) => makeDetails("single", runs),
				});
				const text = truncateBytes(resultText(run), OUTPUT_CAP);
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
			if (tasks.length > MAX_PARALLEL_TASKS)
				return invalidParams(
					`Too many delegated tasks (${tasks.length}). Maximum is ${MAX_PARALLEL_TASKS}.`,
				);

			const efforts = tasks.map((item) =>
				effortFor(item.effort ?? params.effort, config),
			);
			const effortError = efforts.find((result) => result.error)?.error;
			if (effortError) return invalidParams(effortError);
			const liveRuns = tasks.map((item, index) =>
				createRun(item.task, efforts[index].effort),
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

			const contexts = tasks.map(
				(item) => item.context ?? params.context ?? "branch",
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
								? (getSnapshot() ?? undefined)
								: undefined,
						effort: efforts[index].effort,
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
				return `## Task ${index + 1}: ${state}\n\n${resultText(run)}`;
			});
			const text = truncateBytes(
				`Delegated tasks: ${succeeded}/${runs.length} succeeded\n\n${sections.join("\n\n---\n\n")}`,
				OUTPUT_CAP,
			);
			return {
				content: [{ type: "text" as const, text }],
				details: makeDetails("parallel", runs),
				...(succeeded === 0 ? { isError: true as const } : {}),
			};
		},
	});
}
