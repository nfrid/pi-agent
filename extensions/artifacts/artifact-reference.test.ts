import { describe, expect, it } from 'vitest';
import {
  artifactRetrievalHint,
  isArtifactRetrievalHint,
  parseArtifactReference,
  parseReadSnapshotReference,
  parseToolResultArtifactReference,
} from './artifact-reference';

const handle = 'art_1234567890123456789012';
const sha256 =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('artifact reference contract', () => {
  it('parses details.artifact references from any producer', () => {
    expect(
      parseArtifactReference({
        artifact: { handle, sha256, producer: 'web' },
      }),
    ).toEqual({ handle, sha256 });
    expect(parseArtifactReference({ artifact: { handle } })).toBeUndefined();
    expect(parseArtifactReference(undefined)).toBeUndefined();
  });

  it('parses read snapshot references via digest', () => {
    expect(
      parseReadSnapshotReference({
        'artifacts.readSnapshot:v1': { handle, digest: sha256 },
      }),
    ).toEqual({ handle, sha256 });
  });

  it('prefers details.artifact over read snapshot details', () => {
    expect(
      parseToolResultArtifactReference({
        artifact: { handle, sha256 },
        'artifacts.readSnapshot:v1': {
          handle: 'art_otherhandle0000000000',
          digest: sha256,
        },
      }),
    ).toEqual({ handle, sha256 });
  });

  it('matches retrieval hints by handle prefix', () => {
    const hint = artifactRetrievalHint({ handle }, 'json', 12);
    expect(hint).toBe(
      'artifact_retrieve handle=art_1234567890123456789012 mode=json offset=12',
    );
    expect(isArtifactRetrievalHint(hint, { handle })).toBe(true);
    expect(
      isArtifactRetrievalHint(
        'artifact_retrieve handle=art_otherhandle0000000000 mode=lines offset=0',
        { handle },
      ),
    ).toBe(false);
  });
});
