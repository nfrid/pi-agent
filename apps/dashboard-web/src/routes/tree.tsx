import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { RouteShell } from '../app/route-shell';
import {
  HomeRoute,
  InboxRoute,
  LegacyNewRoute,
  ProjectNewThreadRoute,
  ProjectPendingThreadRoute,
  ProjectRoute,
  ProjectsRoute,
  RuntimeRoute,
  SessionRoute,
  SessionsRoute,
} from './components';

const rootRoute = createRootRoute({ component: RouteShell });
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeRoute,
});
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsRoute,
});
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId',
  component: SessionRoute,
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsRoute,
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ProjectRoute,
});
const projectNewThreadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/new',
  component: ProjectNewThreadRoute,
});
const projectPendingThreadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/new/pending/$threadId',
  component: ProjectPendingThreadRoute,
});
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxRoute,
});
const runtimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runtimes/$runtimeId',
  component: RuntimeRoute,
});
const legacyNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/new',
  component: LegacyNewRoute,
});

export const dashboardRouteTree = rootRoute.addChildren([
  homeRoute,
  sessionsRoute,
  sessionRoute,
  projectsRoute,
  projectRoute,
  projectNewThreadRoute,
  projectPendingThreadRoute,
  inboxRoute,
  runtimeRoute,
  legacyNewRoute,
]);

export const dashboardRouterInstance = createRouter({
  routeTree: dashboardRouteTree,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof dashboardRouterInstance;
  }
}
