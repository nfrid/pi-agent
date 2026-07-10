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
const MAX_CONCURRENCY = 5;
const OUTPUT_CAP = 50 * 1024;
const SINGLE_OUTPUT_CAP = 12 * 1024;
const PER_TASK_OUTPUT_CAP = 8 * 1024;

const EffortSchema = StringEnum(EFFORT_LEVELS, {
	description:
		"Optional child model profile. fast favors speed and economy for focused or routine work; balanced provides stronger general-purpose reasoning at moderate cost; deep spends more time and compute on demanding work where additional scrutiny may help. Choose based on the task.",
});

const ContextSchema = StringEnum(["branch", "fresh"] as const, {
	description:
		"Optional context mode. fresh starts with only the task and project instructions; branch also includes parent conversation history. Defaults to fresh to reduce cost.",
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
	allowWrites: Type.Optional(
		Type.Boolean({
			description:
				"Enable edit/write for a deliberate implementation task. Bash remains available for inspection when false.",
		}),
	),
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
	allowWrites: Type.Optional(
		Type.Boolean({
			description:
				"Enable edit/write for a single task, or as the default for parallel tasks. Bash remains available when false.",
		}),
	),
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

function invalidParams(message: string): never {
	throw new Error(message);
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

	pi.on("tool_result", (event) => {
		if (event.toolName !== "delegate") return;
		const details = event.details as DelegateDetails | undefined;
		if (
			details?.runs.length &&
			details.runs.every((run) => run.exitCode !== -1 && isRunError(run))
		)
			return { isError: true };
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate focused work to one or more child Pi processes with isolated context windows.",
			"Use this for exploration, review, validation, debugging, planning, or parallel option checks that would add noisy tool output to the main conversation.",
			"Children start fresh by default to minimize input tokens; pass context: branch only when parent conversation is essential. Delegate is unavailable to children to prevent recursive fan-out.",
			"Children have inspection tools, including bash, by default; edit/write require allowWrites. Read-only bash behavior is policy-based rather than sandboxed. Parallel tasks must not mutate overlapping files.",
		].join(" "),
		promptSnippet:
			"Delegate substantial focused exploration, review, validation, implementation, or independent option checks when a child process would save context or enable useful parallelism.",
		promptGuidelines: [
			"Use delegate autonomously for substantial context-heavy investigation, review, debugging, planning, or independent parallel work when isolating the work would provide a clear benefit.",
			"Prefer direct tool use for routine checks, small edits, and questions answerable with a few tool calls; delegation should earn its additional usage cost.",
			"Prefer the fast effort profile for focused or routine delegated work. Use balanced or deep only when the task's complexity warrants the additional usage.",
			"Delegate children have bash for inspection, but edit/write require allowWrites. Enable allowWrites only for deliberate implementation, and do not give parallel children overlapping mutation scopes.",
			"Delegate cannot be called by child processes; do not ask a delegated child to delegate further.",
		],
		parameters: DelegateParams,
		renderCall: renderDelegateCall,
		renderResult: renderDelegateResult,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const config = loadDelegateConfig(ctx.cwd);
			const snapshots = new Map<string, string | null>();
			const getSnapshot = (cwd: string) => {
				if (snapshots.has(cwd)) return snapshots.get(cwd) ?? null;
				const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager, {
					cwd,
					excludeToolCallId: toolCallId,
				});
				snapshots.set(cwd, snapshot);
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
				const context = params.context ?? "fresh";
				const cwd = params.cwd ?? ctx.cwd;
				const runSnapshot = context === "branch" ? getSnapshot(cwd) : undefined;
				if (context === "branch" && !runSnapshot)
					return invalidParams(
						"Cannot delegate: failed to snapshot current session branch.",
					);
				const run = await runDelegate({
					cwd,
					task,
					context,
					snapshotJsonl: runSnapshot ?? undefined,
					effort: resolved.effort,
					allowWrites: params.allowWrites ?? false,
					signal,
					onUpdate,
					makeDetails: (runs) => makeDetails("single", runs),
				});
				const text = truncateBytes(resultText(run), SINGLE_OUTPUT_CAP);
				return {
					content: [
						{
							type: "text" as const,
							text: isRunError(run) ? `Delegated task failed: ${text}` : text,
						},
					],
					details: makeDetails("single", [run]),
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
			const contexts = tasks.map(
				(item) => item.context ?? params.context ?? "fresh",
			);
			const cwds = tasks.map((item) => item.cwd ?? ctx.cwd);
			const writeModes = tasks.map(
				(item) => item.allowWrites ?? params.allowWrites ?? false,
			);
			const liveRuns = tasks.map((item, index) =>
				createRun(item.task, efforts[index].effort, {
					cwd: cwds[index],
					context: contexts[index],
					allowWrites: writeModes[index],
				}),
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

			for (let index = 0; index < tasks.length; index++) {
				if (contexts[index] !== "branch") continue;
				if (!getSnapshot(cwds[index]))
					return invalidParams(
						"Cannot delegate: failed to snapshot current session branch.",
					);
			}

			emitParallelUpdate();
			const runs = await mapWithConcurrency(
				tasks,
				MAX_CONCURRENCY,
				async (item, index) => {
					const run = await runDelegate({
						cwd: cwds[index],
						task: item.task,
						context: contexts[index],
						snapshotJsonl:
							contexts[index] === "branch"
								? (getSnapshot(cwds[index]) ?? undefined)
								: undefined,
						effort: efforts[index].effort,
						allowWrites: writeModes[index],
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
				return `## Task ${index + 1}: ${state}\n\n${truncateBytes(resultText(run), PER_TASK_OUTPUT_CAP)}`;
			});
			const text = truncateBytes(
				`Delegated tasks: ${succeeded}/${runs.length} succeeded\n\n${sections.join("\n\n---\n\n")}`,
				OUTPUT_CAP,
			);
			return {
				content: [{ type: "text" as const, text }],
				details: makeDetails("parallel", runs),
			};
		},
	});
}
