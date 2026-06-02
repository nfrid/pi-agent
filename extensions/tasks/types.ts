import type { Static } from "typebox";
import type { paramsSchema } from "./schema";

export type Status = "todo" | "doing" | "blocked" | "done" | "dropped";

export type Task = {
	id: string;
	text: string;
	status: Status;
	dependsOn: string[];
	priority?: "low" | "normal" | "high" | "urgent";
	notes?: string;
	createdAt: number;
	updatedAt: number;
};

export type State = {
	version: 1;
	nextId: number;
	tasks: Task[];
};

export type SnapshotEntry = {
	kind: "snapshot";
	state: State;
};

export type Params = Static<typeof paramsSchema>;
export type Action = Params["action"];

export type ToolDetails = {
	action: Action;
	changed: boolean;
	message: string;
	stats: ReturnType<typeof import("./queries").stats>;
	error?: string;
};

export type TodoUiAction =
	| { kind: "close" }
	| { kind: "add" }
	| { kind: "edit"; id: string }
	| { kind: "notes"; id: string }
	| { kind: "deps"; id: string }
	| { kind: "priority"; id: string }
	| { kind: "status"; id: string; status: Status }
	| { kind: "remove"; id: string }
	| { kind: "clear_done" };
