import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodoCommands } from "./commands";
import { flushCompletedPendingHide, persist, reconstruct } from "./state";
import { registerTodoContext, registerTodoTool } from "./tool";
import { updateUi } from "./ui-widget";

export default function tasks(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		reconstruct(ctx);
		updateUi(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		reconstruct(ctx);
		updateUi(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		persist(pi);
		reconstruct(ctx);
		updateUi(ctx);
	});
	pi.on("agent_start", () => {
		if (!flushCompletedPendingHide()) return;
		updateUi();
	});

	registerTodoContext(pi);
	registerTodoTool(pi);
	registerTodoCommands(pi);
}
