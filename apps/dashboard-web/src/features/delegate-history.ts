/** Re-export shim — import from `./delegate/history-compose`. */
export {
  composeDelegateHistory,
  type DelegateCompositeGroup,
  type DelegateCompositeModel,
  type DelegateCompositeRun,
  type DelegateCompositeSection,
  type DelegateInspectionStatus,
  type DelegateWakePresentation,
  delegateHistoryInvocationToStatus,
  delegateHistorySettledRunIds,
  isActiveDelegateStatus,
} from './delegate/history-compose';
