import { modelKeys } from "./model";
import { isPrimarySnapshot, snapshotKeys } from "./normalize";
import type { PiModel, UsageReport, UsageSnapshot } from "./types";

export function selectSnapshot(
	report: UsageReport,
	model: PiModel,
): UsageSnapshot | undefined {
	const keys = modelKeys(model);
	const exact = report.snapshots.find((snapshot) =>
		snapshotKeys(snapshot).some((key) => keys.has(key)),
	);
	return (
		exact ?? report.snapshots.find(isPrimarySnapshot) ?? report.snapshots[0]
	);
}
