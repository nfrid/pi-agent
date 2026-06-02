import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXT } from "./constants";
import { normalizeId } from "./normalize";
import { getTaskStore } from "./store";
import type { SnapshotEntry, State } from "./types";

export const initialState = (): State => ({ version: 1, nextId: 1, tasks: [] });

export function getState(): State {
	return getTaskStore().state;
}

export function getLastCtx(): ExtensionContext | undefined {
	return getTaskStore().lastCtx;
}

export function setLastCtx(ctx: ExtensionContext | undefined): void {
	getTaskStore().lastCtx = ctx;
}

export function getCompletedPendingHide(): Set<string> {
	return getTaskStore().completedPendingHide;
}

export function getHiddenCompleted(): Set<string> {
	return getTaskStore().hiddenCompleted;
}

export function cloneState(): State {
	return JSON.parse(JSON.stringify(getState())) as State;
}

export function applySnapshot(snapshot: State): void {
	const state = getState();
	Object.assign(state, {
		version: 1 as const,
		nextId: Math.max(1, snapshot.nextId || 1),
		tasks: (snapshot.tasks ?? []).map((task) => ({
			...task,
			id: normalizeId(task.id) ?? task.id,
			dependsOn: [
				...new Set(
					(task.dependsOn ?? [])
						.map(normalizeId)
						.filter((id): id is string => Boolean(id)),
				),
			],
			status: task.status ?? "todo",
			createdAt: task.createdAt ?? Date.now(),
			updatedAt: task.updatedAt ?? Date.now(),
		})),
	});
	for (const task of state.tasks) {
		const match = /^T(\d+)$/.exec(task.id);
		if (match) state.nextId = Math.max(state.nextId, Number(match[1]) + 1);
	}
}

export function reconstruct(ctx: ExtensionContext): void {
	setLastCtx(ctx);
	const store = getTaskStore();
	store.state = initialState();
	store.completedPendingHide = new Set();
	store.hiddenCompleted = new Set();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== EXT) continue;
		const data = entry.data as SnapshotEntry | undefined;
		if (data?.kind === "snapshot" && data.state) applySnapshot(data.state);
	}
}

export function persist(pi: ExtensionAPI): void {
	pi.appendEntry(EXT, {
		kind: "snapshot",
		state: cloneState(),
	} satisfies SnapshotEntry);
}

export function flushCompletedPendingHide(): boolean {
	const store = getTaskStore();
	if (!store.completedPendingHide.size) return false;
	store.hiddenCompleted = new Set([
		...store.hiddenCompleted,
		...store.completedPendingHide,
	]);
	store.completedPendingHide = new Set();
	return true;
}
