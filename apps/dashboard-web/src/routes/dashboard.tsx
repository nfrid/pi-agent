// Keep this route module as the compatibility surface for dashboard views.

export {
  AgentThreadNav,
  agentThreadRows,
} from '../features/agent-thread-nav';
export {
  actionNeedsInput,
  CommandPalette,
  paletteItems,
  searchPaletteItems,
} from '../features/command-palette';
export {
  Dashboard,
  RuntimeCard,
} from '../features/dashboard-overview';
export { Header, runtimeStatusCounts } from '../features/navigation';
export { ProjectsView, ProjectView } from '../features/project-catalogue';
export { ProjectNewThreadView } from '../features/project-new-thread';
export { SessionRow } from '../features/session-row';
export { SettingsView } from '../features/settings';
export {
  Back,
  newProjectThreadPath,
  useDashboardNavigate,
} from './navigation';
