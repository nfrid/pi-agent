/**
 * Stable delegate isolation facade. Consumers choose APIs by invariant while the
 * private kernel centralizes shared lock, path-canonicalization, and git
 * primitives that must remain identical across responsibilities.
 */
export * from './isolation/credentials';
export * from './isolation/model';
export * from './isolation/patch-broker';
export * from './isolation/records';
export * from './isolation/sandbox';
export * from './isolation/worktree';
