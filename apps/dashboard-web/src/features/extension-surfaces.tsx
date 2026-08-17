/** Re-export shim — import from `./delegate/` folder. */
export type { ExtensionSurface as LiveExtensionSurface } from '@pi-dashboard/extension-contributions';
export {
  createDelegateHistoryRefreshCoordinator,
  type DelegateHistoryRefreshCoordinator,
  delegateHistoryRevisionChanged,
} from './delegate/history-refresh';
export { DelegateHistorySurface } from './delegate/history-surface';
export {
  activeDelegateTranscriptBaselineFor,
  dashboardSurfacePlacement,
  delegateHistoryRunIds,
  overlayActiveDelegateTranscripts,
  reconcileDelegateLiveRuns,
  renderLiveExtensionSurface,
  runtimeExtensionSurfaces,
  runtimePauseStatus,
  type SurfacePlacement,
  shouldClearDelegateDetailSelection,
  shouldFetchDelegateDetail,
  shouldPromoteDelegateDetailSelection,
} from './delegate/runtime-surfaces';
export { ExtensionSurfaceStack } from './delegate/surface-stack';
export { DelegateTranscript } from './delegate-transcript-inspector';
