// Keep this route module as the compatibility surface for dashboard views.
export {
  actionNeedsInput,
  CommandPalette,
  paletteItems,
} from '../features/command-palette';
export {
  Dashboard,
  Header,
  RuntimeCard,
} from '../features/dashboard-overview';
export { SessionRow } from '../features/workspace-session';
export { WorkspaceView } from '../features/workspace-view';
export { Back, useDashboardNavigate } from './navigation';
