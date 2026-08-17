/**
 * Shared, pure transcript model. The Pi TUI and dashboard web renderer use
 * these same grouping/title rules; neither transport nor terminal rendering is
 * part of this package.
 */
export * from './grouping.js';
export * from './outcome.mjs';
export * from './raw.js';
export * from './title.js';
export * from './tool-presentations.js';
export {
  activityEntriesFromRaw,
  activityGroupBoundary,
  adaptRawTranscriptEntry,
  groupOwningBoundary,
  owningActivityBoundary,
  owningActivityGroup,
  transcriptEntryFromRaw,
} from './transcript-adapter.js';
export * from './types.js';
export * from './view-model.js';
