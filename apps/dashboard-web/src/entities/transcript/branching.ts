import type {
  SessionBranchPoint,
  SessionBranchTopology,
} from '@pi-dashboard/protocol';

export function indexBranchPointsById(
  topology?: SessionBranchTopology,
): Map<string, SessionBranchPoint> {
  return new Map((topology?.points ?? []).map((point) => [point.id, point]));
}

/** Index nested message IDs; the outer anchor remains a chooser identity. */
export function indexBranchPointsByMessageId(
  topology?: SessionBranchTopology,
): Map<string, SessionBranchPoint> {
  const result = new Map<string, SessionBranchPoint>();
  for (const point of topology?.points ?? [])
    for (const path of point.paths) result.set(path.messageId, point);
  return result;
}
