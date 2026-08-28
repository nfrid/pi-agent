import {
  createRuntimeCapabilitySnapshot,
  delegateStatusRenderer,
  type ExtensionManifest,
} from '@pi-dashboard/extension-contributions';

export type {
  DelegateActivity,
  DelegateLifecycleReason,
  DelegatePauseState,
  DelegateRunState,
  DelegateStatus,
  DelegateStatusViewModel,
  DelegateTranscriptEntry,
  DelegateUsage,
  DelegateWakeState,
  DelegateWakeStatus,
  DelegateWorkflowState,
  DelegateWorkflowStatus,
} from '@pi-dashboard/extension-contributions';
export {
  DELEGATE_RENDERER_ID,
  DELEGATE_SURFACE_ID,
  DelegateStatusSchema,
  DelegateStatusViewModelSchema,
  DelegateUsageSchema,
  delegateStatusRenderer,
  projectDelegateUsage,
} from '@pi-dashboard/extension-contributions';

export const DELEGATE_CAPABILITY_ID = 'delegate.live-status';
export const delegateManifest: ExtensionManifest = {
  id: 'delegate',
  version: '1',
  title: 'Delegate',
  actions: [],
  renderers: [delegateStatusRenderer],
};

export const delegateCapabilitySnapshot = createRuntimeCapabilitySnapshot(
  [delegateManifest],
  [
    {
      id: DELEGATE_CAPABILITY_ID,
      version: '1',
      available: true,
      summary: 'Live delegate status and activity snapshots.',
    },
  ],
);
