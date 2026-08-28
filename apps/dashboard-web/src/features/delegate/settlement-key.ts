export function delegateSettlementKey(row: {
  runId: string;
  workflow?: { identity?: string };
}): string {
  const identity = row.workflow?.identity;
  return identity ? `workflow:${identity}` : row.runId;
}
