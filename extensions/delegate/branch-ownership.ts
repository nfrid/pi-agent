import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

/** A small marker written once on each branch that owns delegate state. */
export const DELEGATE_BRANCH_OWNER_ENTRY_TYPE = 'delegate-branch-owner:v1';
export const MAX_BRANCH_OWNER_ID_LENGTH = 256;

export interface DelegateBranchOwnerEntry {
  readonly version: 1;
  readonly ownerBranchId: string;
}

type SessionManager = ExtensionContext['sessionManager'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isBranchOwnerId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_BRANCH_OWNER_ID_LENGTH &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function isBranchOwnerEntry(
  value: unknown,
): value is DelegateBranchOwnerEntry {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isBranchOwnerId(value.ownerBranchId)
  );
}

/** Return a host leaf identity, or undefined when the host cannot identify one. */
export function getSessionLeafId(
  sessionManager: SessionManager,
): string | null | undefined {
  const manager = sessionManager as SessionManager & {
    getLeafId?: () => string | null | undefined;
  };
  if (typeof manager.getLeafId === 'function') {
    const leaf = manager.getLeafId();
    return leaf === '' ? null : leaf;
  }
  const branch = manager.getBranch();
  const last = branch.at(-1) as { id?: unknown } | undefined;
  return typeof last?.id === 'string' ? last.id : undefined;
}

/** A branch's own marker, if one is present in its current ancestry. */
export function branchOwnerMarkers(
  sessionManager: Pick<SessionManager, 'getBranch'>,
): string[] {
  const markers: string[] = [];
  for (const entry of sessionManager.getBranch()) {
    if (
      !isRecord(entry) ||
      entry.type !== 'custom' ||
      entry.customType !== DELEGATE_BRANCH_OWNER_ENTRY_TYPE ||
      !isBranchOwnerEntry(entry.data)
    )
      continue;
    markers.push(entry.data.ownerBranchId);
  }
  return markers;
}

/**
 * Whether an owner marker is in the active branch ancestry. This is deliberately
 * stricter than comparing session IDs: a sibling can share a session while not
 * inheriting the entry that established ownership.
 */
export function branchContainsWorkflowOwner(
  sessionManager: Pick<SessionManager, 'getBranch'>,
  ownerBranchId: string | undefined,
): boolean {
  if (!isBranchOwnerId(ownerBranchId)) return false;
  return sessionManager.getBranch().some((entry) => {
    if (!isRecord(entry)) return false;
    return (
      entry.type === 'custom' &&
      entry.customType === 'delegate-workflow:v1' &&
      isRecord(entry.data) &&
      isRecord(entry.data.state) &&
      Array.isArray(entry.data.state.attempts) &&
      entry.data.state.attempts.some(
        (attempt) =>
          isRecord(attempt) && attempt.ownerBranchId === ownerBranchId,
      )
    );
  });
}

export function branchContainsOwner(
  sessionManager: Pick<SessionManager, 'getBranch'>,
  ownerBranchId: string | undefined,
): boolean {
  if (!isBranchOwnerId(ownerBranchId)) return false;
  for (const entry of sessionManager.getBranch()) {
    if (!isRecord(entry)) continue;
    if (entry.id === ownerBranchId) return true;
    if (
      entry.type === 'custom' &&
      entry.customType === DELEGATE_BRANCH_OWNER_ENTRY_TYPE &&
      isBranchOwnerEntry(entry.data) &&
      entry.data.ownerBranchId === ownerBranchId
    )
      return true;
    // Workflow entries carry the same marker on each attempt. Keeping this
    // fallback lets a valid workflow history establish ownership after a
    // marker entry was written by an older adapter revision.
    if (
      entry.type === 'custom' &&
      entry.customType === 'delegate-workflow:v1' &&
      isRecord(entry.data) &&
      isRecord(entry.data.state) &&
      Array.isArray(entry.data.state.attempts) &&
      entry.data.state.attempts.some(
        (attempt) =>
          isRecord(attempt) && attempt.ownerBranchId === ownerBranchId,
      )
    )
      return true;
  }
  return false;
}

/** Persist only the bounded owner token; exact delegate values never enter it. */
export function appendBranchOwnerMarker(
  pi: Pick<ExtensionContext, never> & {
    appendEntry: (type: string, data: unknown) => void;
  },
  ownerBranchId: string,
): void {
  if (!isBranchOwnerId(ownerBranchId))
    throw new Error('Cannot persist an invalid delegate branch owner ID.');
  pi.appendEntry(DELEGATE_BRANCH_OWNER_ENTRY_TYPE, {
    version: 1,
    ownerBranchId,
  } satisfies DelegateBranchOwnerEntry);
}

/** Resolve the event's destination leaf without trusting a stale context leaf. */
export function eventLeafId(event: unknown): string | null | undefined {
  if (!isRecord(event) || !Object.hasOwn(event, 'newLeafId')) return undefined;
  const value = event.newLeafId;
  if (value === '' || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** Convert the root leaf to a stable local key; preserve unavailable as undefined. */
export function branchRuntimeKey(
  leaf: string | null | undefined,
): string | undefined {
  if (leaf === undefined) return undefined;
  return leaf ?? 'root';
}
