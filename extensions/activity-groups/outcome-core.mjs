// Compatibility entry point for Node-based session metrics. The implementation
// lives in the shared activity-model package so dashboard and TUI outcomes
// cannot drift.
export {
  hasUnresolvedToolFailure,
  validationKindsOf,
} from '../../packages/activity-model/src/outcome.mjs';
