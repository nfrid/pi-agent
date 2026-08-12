import { DashboardBootstrap } from './app/bootstrap';

export {
  DashboardContext,
  type DashboardContextValue,
  useDashboardContext,
} from './app/dashboard-context';
export {
  isNearPageBottom,
  sessionCursorRangeCovered,
  sessionDisplayTitle,
  sessionNavigationTarget,
  shouldApplySessionMetadata,
  shouldShowJumpToLatest,
} from './app-helpers';
export {
  api,
  asBrowserSnapshot,
  asSessionResponse,
} from './dashboard-transport';
export {
  buildTranscriptLandmarks,
  shouldShowActivityLead,
} from './entities/transcript';
export {
  AgentThreadNav,
  agentThreadRows,
  boundedAgentThreadRows,
} from './features/agent-thread-nav';
export {
  addImageAttachments,
  composerDraftStorageKey,
  contextIndicatorData,
  formatContextTokens,
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
