/**
 * Versioned, framework-independent dashboard bridge contracts.
 *
 * This compatibility barrel intentionally preserves the original public API;
 * implementation details live in cohesive schema, parser, semantic, and
 * redaction modules.
 */

export * from './parsers.js';
export * from './redaction.js';
export * from './schemas.js';
export * from './semantic.js';
export {
  isRecord,
  isRuntimeLiveState,
  parseSchema,
  tryParseSchema,
} from './utils.js';
