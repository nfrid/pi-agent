// Keep this route module as the compatibility surface for dashboard views.

export {
  AgentThreadNav,
  agentThreadRows,
  boundedAgentThreadRows,
} from '../features/agent-thread-nav';
export {
  actionNeedsInput,
  CommandPalette,
  paletteItems,
} from '../features/command-palette';
export {
  Dashboard,
  RuntimeCard,
  SessionsView,
  WorkspacesView,
} from '../features/dashboard-overview';
export { InboxView } from '../features/inbox';
export { Header, runtimeStatusCounts } from '../features/navigation';
export { SessionRow } from '../features/workspace-session';
export { WorkspaceView } from '../features/workspace-view';
export { Back, useDashboardNavigate } from './navigation';
