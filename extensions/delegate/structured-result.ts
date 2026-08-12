/**
 * Structured delegate result contract surface.
 *
 * Split by concern: schema normalization, projection/validation, child channel
 * settlement, public serializers, and child tool registration.
 */

export {
  captureDelegateResultEvent,
  getDelegateChannelPresent,
  getDelegateResultSpec,
  getSettledDelegateResult,
  getStructuredArtifacts,
  getUserVisibleStructuredResult,
  redactDelegateResultTerminalProse,
  setDelegateResultSpec,
  setStructuredArtifacts,
  settleDelegateResult,
} from './structured-result-channel';
export {
  projectStructuredResult,
  selectStructuredPath,
  validateStructuredResult,
} from './structured-result-project';
export {
  asToolSchema,
  type DelegateResultSpecInput,
  type JsonSchemaNode,
  type NormalizedDelegateResultSpec,
  normalizeDelegateResultSpec,
  STRUCTURED_RESULT_CAPS,
  STRUCTURED_RESULT_LIMITS,
  type StructuredArtifacts,
  type StructuredProjectionResult,
  type StructuredValidationResult,
} from './structured-result-schema';
export {
  boundPublicStructuredRuns,
  formatStructuredResult,
  PUBLIC_STRUCTURED_RESULT_CAPS,
  serializeDelegateRunForPublic,
  serializeDelegateRunForStaleSession,
} from './structured-result-serialize';
export {
  parseChildDelegateResultSpec,
  registerChildDelegateResultTool,
} from './structured-result-tool';
