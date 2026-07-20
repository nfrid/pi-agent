import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createWebResultStore,
  type StoredSearchData,
  WEB_REFERENCE_TYPE,
} from '../storage';

const store = createWebResultStore();

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
  store.restore({
    sessionManager: { getBranch: () => entries },
  } as never);
}

describe('web artifact producer storage', () => {
  it('isolates continuation state between extension instances', () => {
    const first = createWebResultStore();
    const second = createWebResultStore();
    const data: StoredSearchData = {
      id: 'instance-only',
      type: 'fetch',
      timestamp: 1,
      urls: [],
    };
    first.store(data.id, data);
    expect(first.get(data.id)).toEqual(data);
    expect(second.get(data.id)).toBeNull();
    second.clear();
    expect(first.get(data.id)).toEqual(data);
  });

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
    expect(store.get(data.id)).toEqual(data);
    expect(store.artifact(data.id)).toEqual(fixture.metadata);
    expect(JSON.stringify(fixture.metadata)).not.toContain('secret.example');
    expect(
      Buffer.from(
        (fixture.entries[0] as { data: { bytes: string } }).data.bytes,
        'base64',
      ).toString(),
    ).toBe(JSON.stringify(data));
  });

  it.each([
    ['createdAt', '2001-01-01T00:00:00.000Z'],
    ['mediaType', 'text/plain'],
    ['creationSource', 'web.other'],
    ['lineCount', 2],
    ['itemCount', 999],
    ['encoding', 'binary'],
  ] as const)('rejects reference metadata that diverges only in %s', (field, value) => {
    const data: StoredSearchData = {
      id: `tampered-${field}`,
      type: 'fetch',
      timestamp: 1,
      urls: [],
    };
    const fixture = artifactEntries(data);
    const reference = fixture.entries[1] as {
      data: { artifact: Record<string, unknown> };
    };
    reference.data.artifact = {
      ...reference.data.artifact,
      [field]: value,
    };
    restore(fixture.entries);
    expect(store.get(data.id)).toBeNull();
    expect(store.artifact(data.id)).toBeUndefined();
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
    expect(store.get(data.id)).toBeNull();
    expect(store.artifact(data.id)).toBeUndefined();
  });

  it('ignores malformed tombstones and later malformed recoveries', () => {
    const data: StoredSearchData = {
      id: 'valid-before-malformed',
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
          revokedAt: 'not-a-date',
        },
      },
      {
        type: 'custom',
        customType: 'artifact:v1',
        data: {
          version: 1,
          kind: 'recovery',
          metadata: fixture.metadata,
          bytes: '!!!!',
        },
      },
    ]);
    expect(store.get(data.id)).toEqual(data);
    expect(store.artifact(data.id)).toEqual(fixture.metadata);
  });

  it('rebuilds the branch index instead of merging stale response IDs', () => {
    const first: StoredSearchData = {
      id: 'first-branch',
      type: 'fetch',
      timestamp: 1,
      urls: [],
    };
    const second: StoredSearchData = {
      id: 'second-branch',
      type: 'fetch',
      timestamp: 1,
      urls: [],
    };
    restore(artifactEntries(first).entries);
    expect(store.get(first.id)).toEqual(first);
    restore(artifactEntries(second).entries);
    expect(store.get(first.id)).toBeNull();
    expect(store.get(second.id)).toEqual(second);
  });
});
