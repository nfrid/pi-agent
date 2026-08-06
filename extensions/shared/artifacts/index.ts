/**
 * Artifact storage: keeps oversized tool output out of the context window.
 *
 * A producer hands over bytes and gets back a handle plus a short preview to
 * show the agent; the agent pulls bounded slices back through
 * `artifact_retrieve` when it actually needs them. One agent owns its own
 * artifacts, so there is no sharing, no concurrency, and no locking here.
 */
export { collectGarbage } from './gc';
export {
  RETRIEVAL_MODES,
  type RetrievalMode,
  type RetrievalRequest,
  renderRetrievalResult,
  retrieveArtifact,
} from './retrieval';
export {
  artifactRoot,
  clearArtifactRoot,
  type PutArtifactOptions,
  putArtifact,
  recoverArtifactFromEntries,
  resolveArtifact,
  resolveArtifactView,
  restoreArtifacts,
} from './storage';
export type {
  ArtifactMetadata,
  ArtifactViewRegistryEntry,
  ContentClass,
  ProducerClass,
  PutArtifactInput,
  ResolvedArtifact,
} from './types';
export {
  ARTIFACT_ENTRY_TYPE,
  ARTIFACT_VIEW_ENTRY_TYPE,
  MAX_ARTIFACT_BYTES,
} from './types';
export { validateMetadata } from './validation';

import { putArtifact, recoverArtifactFromEntries } from './storage';

/** What producers are allowed to do: publish bytes, nothing else. */
export const artifactProducer = { put: putArtifact } as const;

/** What consumers are allowed to do: re-resolve a reference they hold. */
export const artifactConsumer = {
  recoverFromEntries: recoverArtifactFromEntries,
} as const;
