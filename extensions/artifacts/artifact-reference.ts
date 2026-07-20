import { asRecord } from '../shared/object';
import { HANDLE_RE } from './storage-validation';

const SHA256_RE = /^[a-f0-9]{64}$/;

export interface ArtifactReference {
  handle: string;
  sha256: string;
}

function validReference(
  handle: unknown,
  sha256: unknown,
): ArtifactReference | undefined {
  if (
    typeof handle === 'string' &&
    HANDLE_RE.test(handle) &&
    typeof sha256 === 'string' &&
    SHA256_RE.test(sha256)
  )
    return { handle, sha256 };
  return undefined;
}

/** Parse a tool-result `details.artifact` reference published by any producer. */
export function parseArtifactReference(
  details: unknown,
): ArtifactReference | undefined {
  const artifact = asRecord(asRecord(details)?.artifact);
  if (!artifact) return undefined;
  return validReference(artifact.handle, artifact.sha256);
}

/** Read snapshots use `digest` instead of `sha256` under a dedicated details key. */
export function parseReadSnapshotReference(
  details: unknown,
  key = 'artifacts.readSnapshot:v1',
): ArtifactReference | undefined {
  const snapshot = asRecord(asRecord(details)?.[key]);
  if (!snapshot) return undefined;
  return validReference(snapshot.handle, snapshot.digest);
}

export function parseToolResultArtifactReference(
  details: unknown,
): ArtifactReference | undefined {
  return parseArtifactReference(details) ?? parseReadSnapshotReference(details);
}

export function artifactRetrievalHint(
  reference: Pick<ArtifactReference, 'handle'>,
  mode: 'lines' | 'json' = 'lines',
  offset = 0,
): string {
  return `artifact_retrieve handle=${reference.handle} mode=${mode} offset=${offset}`;
}

export function isArtifactRetrievalHint(
  retrieval: string,
  reference: Pick<ArtifactReference, 'handle'>,
): boolean {
  return retrieval.startsWith(
    `artifact_retrieve handle=${reference.handle} mode=`,
  );
}
