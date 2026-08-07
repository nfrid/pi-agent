/**
 * Compatibility barrel for the versioned dashboard contracts.
 *
 * New code should import one of the focused modules directly. The barrel is
 * intentionally kept stable for Pi extensions and older browser clients.
 */
export * from './dashboard-api.js';
export * from './orchestration-contracts.js';
export * from './pi-runtime-protocol.js';
export {
  isRecord,
  isRuntimeLiveState,
  parseSchema,
  tryParseSchema,
} from './utils.js';
