import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const taskSchema = Type.Object({
	id: Type.String({
		description: "Stable task id, e.g. T1. Required for replace.",
	}),
	text: Type.String(),
	status: Type.Optional(
		StringEnum(["todo", "doing", "blocked", "done", "dropped"] as const),
	),
	depends_on: Type.Optional(Type.Array(Type.String())),
	priority: Type.Optional(
		StringEnum(["low", "normal", "high", "urgent"] as const),
	),
	notes: Type.Optional(Type.String()),
});

export const paramsSchema = Type.Object({
	action: StringEnum([
		"list",
		"add",
		"update",
		"start",
		"done",
		"block",
		"drop",
		"remove",
		"clear_done",
		"replace",
		"batch",
	] as const),
	id: Type.Optional(
		Type.String({
			description: "Task id for update/start/done/block/drop/remove.",
		}),
	),
	text: Type.Optional(
		Type.String({ description: "Task text for add/update." }),
	),
	status: Type.Optional(
		StringEnum(["todo", "doing", "blocked", "done", "dropped"] as const),
	),
	depends_on: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task ids this task depends on.",
		}),
	),
	priority: Type.Optional(
		StringEnum(["low", "normal", "high", "urgent"] as const),
	),
	notes: Type.Optional(
		Type.String({ description: "Extra context or block reason." }),
	),
	include_done: Type.Optional(
		Type.Boolean({ description: "For list: include done/dropped tasks." }),
	),
	tasks: Type.Optional(
		Type.Array(taskSchema, {
			description: "For replace: complete desired task set.",
		}),
	),
	operations: Type.Optional(
		Type.Array(Type.Any(), {
			description:
				'For batch: all already-known mutations as ordered todo operations, each shaped like a todo call except action=batch. Example: [{"action":"done","id":"T1"},{"action":"start","id":"T2"}].',
		}),
	),
});
