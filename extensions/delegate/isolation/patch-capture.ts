import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { brokerPath, readBrokerFile, replaceBrokerFile } from './broker-fs';
import { withIsolationLock } from './locks';
import type { IsolationRecord } from './model';
import { captureIsolationPatchUnlocked } from './patch-capture-unlocked';

export async function captureIsolationPatch(
  id: string,
  options: {
    outcome?: IsolationRecord['runOutcome'];
  } = {},
): Promise<IsolationRecord> {
  return withIsolationLock(id, () =>
    captureIsolationPatchUnlocked(id, options),
  );
}

export function isolationPatchBytes(
  record: IsolationRecord,
): Buffer | undefined {
  const patchPath = brokerPath(record, 'changes.patch');
  if (!record.patch) return;
  if (!existsSync(patchPath)) {
    const legacyPath = path.join(record.scratchPath, 'changes.patch');
    try {
      const legacy = readBrokerFile(legacyPath);
      if (
        createHash('sha256').update(legacy).digest('hex') !==
        record.patch.sha256
      )
        return;
      replaceBrokerFile(patchPath, legacy);
    } catch {
      return;
    }
  }
  let bytes: Buffer;
  try {
    bytes = readBrokerFile(patchPath);
  } catch {
    return;
  }
  return createHash('sha256').update(bytes).digest('hex') ===
    record.patch.sha256
    ? bytes
    : undefined;
}
