import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  clearResults,
  getResult,
  getResultArtifact,
  restoreFromSession,
  type StoredSearchData,
  WEB_REFERENCE_TYPE,
} from '../storage';

function artifactEntries(data: StoredSearchData) {
  const bytes = Buffer.from(JSON.stringify(data));
  const metadata = {
    handle: `art_${'w'.repeat(22)}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    producer: 'web' as const,
    contentClass: 'json' as const,
    mediaType: 'application/json',
    creationSource: `web.${data.type}`,
    encoding: 'utf-8' as const,
    lineCount: 1,
    itemCount: Object.keys(data).length,
    createdAt: '2000-01-01T00:00:00.000Z',
  };
  return {
    metadata,
    entries: [
      {
        type: 'custom',
        customType: 'artifact:v1',
        data: {
          version: 1,
          kind: 'recovery',
          metadata,
          bytes: bytes.toString('base64'),
        },
      },
      {
        type: 'custom',
        customType: WEB_REFERENCE_TYPE,
        data: {
          version: 1,
          responseId: data.id,
          resultType: data.type,
          artifact: metadata,
        },
      },
    ],
  };
}

function restore(entries: unknown[]) {
  restoreFromSession({
    sessionManager: { getBranch: () => entries },
  } as never);
}

describe('web artifact producer storage', () => {
  it('recovers exact artifact JSON without age expiry and keeps URLs out of metadata', () => {
    const data: StoredSearchData = {
      id: 'old-response',
      type: 'fetch',
      timestamp: 1,
      urls: [
        {
          url: 'https://secret.example/raw?token=value',
          title: 'page',
          content: 'exact body\n',
          error: null,
        },
      ],
    };
    const fixture = artifactEntries(data);
    restore(fixture.entries);
    expect(getResult(data.id)).toEqual(data);
    expect(getResultArtifact(data.id)).toEqual(fixture.metadata);
    expect(JSON.stringify(fixture.metadata)).not.toContain('secret.example');
    expect(
      Buffer.from(
        (fixture.entries[0] as { data: { bytes: string } }).data.bytes,
        'base64',
      ).toString(),
    ).toBe(JSON.stringify(data));
  });

  it('does not restore artifact-backed web data after handle revocation', () => {
    const data: StoredSearchData = {
      id: 'revoked-response',
      type: 'fetch',
      timestamp: 1,
      urls: [],
    };
    const fixture = artifactEntries(data);
    restore([
      ...fixture.entries,
      {
        type: 'custom',
        customType: 'artifact:v1',
        data: {
          version: 1,
          kind: 'revoke',
          handle: fixture.metadata.handle,
          revokedAt: '2000-01-01T00:00:01.000Z',
        },
      },
    ]);
    expect(getResult(data.id)).toBeNull();
    expect(getResultArtifact(data.id)).toBeUndefined();
  });

  it('restores compatible legacy web-search-results entries', () => {
    const data: StoredSearchData = {
      id: 'legacy',
      type: 'search',
      timestamp: Date.now(),
      queries: [],
      summary: 'legacy summary',
    };
    restore([{ type: 'custom', customType: 'web-search-results', data }]);
    expect(getResult('legacy')).toEqual(data);
    expect(getResultArtifact('legacy')).toBeUndefined();
    clearResults();
  });
});
