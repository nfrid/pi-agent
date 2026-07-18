import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveArtifact } from './storage';
import { sha256 } from './storage-validation';
import type { ResolvedArtifact } from './types';

export type ArtifactResolver = (
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  handle: string,
  root?: string,
) => Promise<ResolvedArtifact | undefined>;

/** Resolve an artifact and independently verify it against a consumer digest. */
export async function resolveVerifiedArtifact(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  handle: string,
  expectedSha256: string,
  resolver: ArtifactResolver = resolveArtifact,
  root?: string,
) {
  const artifact =
    root === undefined
      ? await resolver(ctx, handle)
      : await resolver(ctx, handle, root);
  if (
    !artifact ||
    artifact.metadata.sha256 !== expectedSha256 ||
    sha256(artifact.bytes) !== expectedSha256
  )
    return undefined;
  return artifact;
}
