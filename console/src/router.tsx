import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import type { GatewayStatus } from './api/types';
import { AppShell } from './components/app-shell';
import {
  adaptiveSkillsAmendmentsQueryOptions,
  adaptiveSkillsHealthQueryOptions,
  gatewayStatusQueryOptions,
  jobsContextQueryOptions,
  overviewQueryOptions,
  schedulerQueryOptions,
  sessionsQueryOptions,
  skillsQueryOptions,
} from './queries';
import { AuditPage } from './routes/audit';
import { ChannelsPage } from './routes/channels';
import { ConfigPage } from './routes/config';
import { DashboardPage } from './routes/dashboard';
import { GatewayPage } from './routes/gateway';
import { JobsPage } from './routes/jobs';
import { McpPage } from './routes/mcp';
import { ModelsPage } from './routes/models';
import { PluginsPage } from './routes/plugins';
import { SchedulerPage } from './routes/scheduler';
import { SessionsPage } from './routes/sessions';
import { SkillsPage } from './routes/skills';
import { ToolsPage } from './routes/tools';

const LazyTerminalPage = lazy(async () => {
  const mod = await import('./routes/terminal');
  return { default: mod.TerminalPage };
});

function TerminalRouteComponent() {
  return (
    <Suspense fallback={<div className="empty-state">Loading terminal…</div>}>
      <LazyTerminalPage />
    </Suspense>
  );
}

function RootLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

interface RouterContext {
  gatewayStatus: GatewayStatus | null;
  queryClient: QueryClient;
  token: string;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(overviewQueryOptions(context.token)),
      context.queryClient.ensureQueryData({
        ...gatewayStatusQueryOptions(context.token),
        initialData: context.gatewayStatus ?? undefined,
      }),
    ]);
  },
  component: DashboardPage,
});

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terminal',
  component: TerminalRouteComponent,
});

const gatewayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gateway',
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      ...gatewayStatusQueryOptions(context.token),
      initialData: context.gatewayStatus ?? undefined,
    }),
  component: GatewayPage,
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(sessionsQueryOptions(context.token)),
  component: SessionsPage,
});

const channelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/channels',
  component: ChannelsPage,
});

const configRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/config',
  component: ConfigPage,
});

const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/models',
  component: ModelsPage,
});

const schedulerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/scheduler',
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(schedulerQueryOptions(context.token)),
  component: SchedulerPage,
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(schedulerQueryOptions(context.token)),
      context.queryClient.ensureQueryData(
        jobsContextQueryOptions(context.token),
      ),
    ]);
  },
  component: JobsPage,
});

const mcpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mcp',
  component: McpPage,
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: AuditPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/skills',
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(skillsQueryOptions(context.token)),
      context.queryClient.ensureQueryData(
        adaptiveSkillsHealthQueryOptions(context.token),
      ),
      context.queryClient.ensureQueryData(
        adaptiveSkillsAmendmentsQueryOptions(context.token),
      ),
    ]);
  },
  component: SkillsPage,
});

const pluginsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plugins',
  component: PluginsPage,
});

const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tools',
  component: ToolsPage,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  terminalRoute,
  gatewayRoute,
  sessionsRoute,
  channelsRoute,
  configRoute,
  modelsRoute,
  schedulerRoute,
  jobsRoute,
  mcpRoute,
  auditRoute,
  skillsRoute,
  pluginsRoute,
  toolsRoute,
]);

export const router = createRouter({
  basepath: '/admin',
  context: {
    queryClient: undefined as never,
    token: '',
    gatewayStatus: null,
  },
  routeTree,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
