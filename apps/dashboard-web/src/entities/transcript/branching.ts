import type {
  SessionBranchPoint,
  SessionBranchTopology,
} from '@pi-dashboard/protocol';

export function indexBranchPointsById(
  topology?: SessionBranchTopology,
): Map<string, SessionBranchPoint> {
  return new Map((topology?.points ?? []).map((point) => [point.id, point]));
}

/** Index only choice IDs; the anchor remains the chooser identity, not a marker. */
export function indexBranchPointsByMemberId(
  topology?: SessionBranchTopology,
): Map<string, SessionBranchPoint> {
  const result = new Map<string, SessionBranchPoint>();
  for (const point of topology?.points ?? [])
    for (const memberId of point.memberIds) result.set(memberId, point);
  return result;
}
