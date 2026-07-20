/**
 * Stable delegate isolation facade. Consumers choose APIs by invariant while the
 * private kernel centralizes shared lock, path-canonicalization, and git
 * primitives that must remain identical across responsibilities.
 */
export * from './isolation/credentials';
export * from './isolation/model';
export {
  applyIsolationPatch,
  isolationPatchEligibility,
} from './isolation/patch-apply';
export {
  captureIsolationPatch,
  isolationPatchBytes,
} from './isolation/patch-capture';
export { discardIsolation } from './isolation/patch-discard';
export {
  isolationValidationCommand,
  isolationValidationScript,
  validateIsolationCommand,
  validateIsolationPatch,
} from './isolation/patch-validate';
export * from './isolation/records';
export * from './isolation/sandbox';
export * from './isolation/worktree';
