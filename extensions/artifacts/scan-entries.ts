import {
  HANDLE_RE,
  validRecoveryBytes,
  validTombstone,
} from './storage-validation';
import {
  ARTIFACT_ENTRY_TYPE,
  type RecoveryEntry,
  type TombstoneEntry,
} from './types';

export interface ScannedArtifactEntry {
  entry: RecoveryEntry;
  bytes: Buffer;
}

export interface ScannedArtifacts {
  recovered: Map<string, ScannedArtifactEntry>;
  revoked: Set<string>;
}

/** Walk custom artifact entries and collect the latest recovery/revoke state. */
export function scanArtifactEntries(
  entries: Iterable<{
    type: string;
    customType?: string;
    data?: unknown;
  }>,
): ScannedArtifacts {
  const recovered = new Map<string, ScannedArtifactEntry>();
  const revoked = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== ARTIFACT_ENTRY_TYPE)
      continue;
    const data = entry.data as RecoveryEntry | TombstoneEntry | undefined;
    if (data?.version !== 1) continue;
    if (validTombstone(data)) {
      recovered.delete(data.handle);
      revoked.add(data.handle);
    } else if (data.kind === 'recovery') {
      const bytes = validRecoveryBytes(data);
      if (bytes) {
        recovered.set(data.metadata.handle, { entry: data, bytes });
        revoked.delete(data.metadata.handle);
      }
    }
  }
  return { recovered, revoked };
}

export function recoverExpectedArtifact(
  scanned: ScannedArtifacts,
  expected: { handle: string },
): ScannedArtifactEntry | undefined {
  if (!HANDLE_RE.test(expected.handle)) return undefined;
  return scanned.recovered.get(expected.handle);
}
