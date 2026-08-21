import { DashboardBootstrap } from './app/bootstrap';

export {
  api,
  asBrowserSnapshot,
  asSessionResponse,
} from '@pi-dashboard/client';
export {
  DashboardContext,
  type DashboardContextValue,
  useDashboardContext,
} from './app/dashboard-context';
export {
  isNearPageBottom,
  sessionDisplayTitle,
  sessionNavigationTarget,
  shouldApplySessionMetadata,
  shouldShowJumpToLatest,
  sortWorkspacesByRecency,
} from './app-helpers';
export {
  buildTranscriptLandmarks,
  shouldShowActivityLead,
} from './entities/transcript';
export {
  AgentThreadNav,
  activeThreadDetails,
  agentThreadRows,
  boundedAgentThreadRows,
} from './features/agent-thread-nav';
export {
  addImageAttachments,
  composerDraftStorageKey,
  contextIndicatorData,
  formatContextTokens,
  mergeQueuedMessages,
  queueCommand,
  queuedMessagesForRuntime,
  queueRemoveCommand,
  readComposerDraft,
  resumeRuntimeRequest,
  runtimeSupportsImages,
  shouldShowQueuePanel,
  upsertQueuedMessage,
  writeComposerDraft,
} from './features/composer';
export {
  ExtensionSurfaceStack,
  renderLiveExtensionSurface,
  runtimeExtensionSurfaces,
} from './features/extension-surfaces';
export {
  newChatModelOptions,
  newChatRequest,
  newChatThinkingLevels,
  pendingChatPath,
  preferredNewChatRuntime,
  sessionPathForRuntime,
} from './features/new-chat';
export { newChatPath } from './routes/navigation';
export { dashboardRouterInstance, dashboardRouteTree } from './routes/tree';
export { toTranscriptEntries } from './transcript';

export default function App() {
  return <DashboardBootstrap />;
}
