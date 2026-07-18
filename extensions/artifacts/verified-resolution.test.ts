import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from './storage-validation';
import type { ResolvedArtifact } from './types';
import {
  type ArtifactResolver,
  resolveVerifiedArtifact,
} from './verified-resolution';

const ctx = {
  sessionManager: {},
} as unknown as Pick<ExtensionContext, 'sessionManager'>;

function artifact(bytes = Buffer.from('verified')): ResolvedArtifact {
  return {
    bytes,
    metadata: {
      handle: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      sha256: sha256(bytes),
      size: bytes.length,
      producer: 'extension',
      contentClass: 'text',
      creationSource: 'test',
      encoding: 'utf-8',
      createdAt: '2026-07-18T00:00:00.000Z',
    },
  };
}

describe('verified artifact resolution', () => {
  it('independently accepts only matching metadata and bytes', async () => {
    const valid = artifact();
    const resolver = vi.fn(async () => valid);
    await expect(
      resolveVerifiedArtifact(
        ctx,
        valid.metadata.handle,
        valid.metadata.sha256,
        resolver,
      ),
    ).resolves.toBe(valid);

    await expect(
      resolveVerifiedArtifact(
        ctx,
        valid.metadata.handle,
        '0'.repeat(64),
        resolver,
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolveVerifiedArtifact(
        ctx,
        valid.metadata.handle,
        valid.metadata.sha256,
        async () => ({ ...valid, bytes: Buffer.from('tampered') }),
      ),
    ).resolves.toBeUndefined();
  });

  it('preserves two-argument resolver calls when no root is supplied', async () => {
    const valid = artifact();
    const arities: number[] = [];
    const resolver: ArtifactResolver = async (...args) => {
      arities.push(args.length);
      return valid;
    };
    await resolveVerifiedArtifact(
      ctx,
      valid.metadata.handle,
      valid.metadata.sha256,
      resolver,
    );
    expect(arities).toEqual([2]);
  });

  it('forwards an explicit storage root', async () => {
    const valid = artifact();
    const resolver = vi.fn(async () => valid);
    await resolveVerifiedArtifact(
      ctx,
      valid.metadata.handle,
      valid.metadata.sha256,
      resolver,
      '/artifact-root',
    );
    expect(resolver).toHaveBeenCalledWith(
      ctx,
      valid.metadata.handle,
      '/artifact-root',
    );
  });
});
