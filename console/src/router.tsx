import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { AppShell } from './components/app-shell';
import { resolveBrowserTitle } from './lib/browser-title';
import { A2AInboxPage } from './routes/a2a-inbox';
import { A2ATrustPage } from './routes/a2a-trust';
import { AgentsPage } from './routes/agent-scoreboard';
import { AgentFilesPage } from './routes/agents';
import { AgentsOverviewPage } from './routes/agents-overview';
import { ApprovalsPage } from './routes/approvals';
import { AuditPage } from './routes/audit';
import { ChannelsPage } from './routes/channels';
import { ConfigPage } from './routes/config';
import { ConnectorsPage } from './routes/connectors';
import { DashboardPage } from './routes/dashboard';
import { DistillPage } from './routes/distill';
import { EmailPage } from './routes/email';
import { FleetTopologyPage } from './routes/fleet-topology';
import { GatewayPage } from './routes/gateway';
import { HarnessEvolutionPage } from './routes/harness-evolution';
import { JobsPage } from './routes/jobs';
import { LogsPage } from './routes/logs';
import { McpPage } from './routes/mcp';
import { ModelsPage } from './routes/models';
import { OutputGuardPage } from './routes/output-guard';
import { PluginsPage } from './routes/plugins';
import { SchedulerPage } from './routes/scheduler';
import { SecretsPage } from './routes/secrets';
import { SessionsPage } from './routes/sessions';
import { SkillsDetailPage } from './routes/skill-detail';
import { SkillsPage } from './routes/skills';
import { StatisticsPage } from './routes/statistics';
import { TeamsPage } from './routes/teams';
import { TokensPage } from './routes/tokens';
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

const LazyChatPage = lazy(async () => {
  const mod = await import('./routes/chat');
  return { default: mod.ChatPage };
});

function ChatRouteComponent() {
  return (
    <Suspense fallback={<div className="empty-state">Loading chat…</div>}>
      <LazyChatPage />
    </Suspense>
  );
}

const LazyAppsPage = lazy(async () => {
  const mod = await import('./routes/apps');
  return { default: mod.AppsPage };
});

function AppsRouteComponent() {
  return (
    <Suspense fallback={<div className="empty-state">Loading apps…</div>}>
      <LazyAppsPage />
    </Suspense>
  );
}

function optionalStringSearchValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function BrowserTitle() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  useEffect(() => {
    document.title = resolveBrowserTitle(pathname);
  }, [pathname]);

  return null;
}

function RootRouteComponent() {
  return (
    <>
      <BrowserTitle />
      <Outlet />
    </>
  );
}

const rootRoute = createRootRoute({
  component: RootRouteComponent,
});

function AppShellRouteComponent() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

const adminLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_admin_layout',
  component: AppShellRouteComponent,
});

const agentsOverviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  component: AgentsOverviewPage,
});

const dashboardRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin',
  component: DashboardPage,
});

const statisticsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/statistics',
  component: StatisticsPage,
});

const approvalsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/approvals',
  component: ApprovalsPage,
});

const a2aInboxRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/a2a-inbox',
  component: A2AInboxPage,
});

const a2aTrustRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/a2a-trust',
  component: A2ATrustPage,
});

const agentFilesRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/agents',
  component: AgentFilesPage,
});

const agentScoreboardRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/agent-scoreboard',
  component: AgentsPage,
});

const terminalRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/terminal',
  component: TerminalRouteComponent,
});

const gatewayRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/gateway',
  component: GatewayPage,
});

const logsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/logs',
  component: LogsPage,
});

const fleetTopologyRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/fleet-topology',
  component: FleetTopologyPage,
});

const sessionsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/sessions',
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId: optionalStringSearchValue(search.sessionId),
  }),
  component: SessionsPage,
});

const channelsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/channels',
  component: ChannelsPage,
});

const teamsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/teams',
  component: TeamsPage,
});

const emailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/email',
  component: EmailPage,
});

const configRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/config',
  component: ConfigPage,
});

const modelsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/models',
  component: ModelsPage,
});

const schedulerRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/scheduler',
  validateSearch: (search: Record<string, unknown>) => ({
    jobId: optionalStringSearchValue(search.jobId),
  }),
  component: SchedulerPage,
});

const jobsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/jobs',
  component: JobsPage,
});

const harnessEvolutionRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/harness-evolution',
  component: HarnessEvolutionPage,
});

const distillRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/distill',
  component: DistillPage,
});

const mcpRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/mcp',
  component: McpPage,
});

const connectorsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/connectors',
  component: ConnectorsPage,
});

const auditRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/audit',
  validateSearch: (search: Record<string, unknown>) => ({
    q: optionalStringSearchValue(search.q),
    range: optionalStringSearchValue(search.range),
  }),
  component: AuditPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/skills',
  component: SkillsPage,
});

const skillDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/skills/$skillName',
  component: SkillsDetailPage,
});

const pluginsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/plugins',
  component: PluginsPage,
});

const outputGuardRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/output-guard',
  component: OutputGuardPage,
});

const toolsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/tools',
  component: ToolsPage,
});

const secretsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/secrets',
  component: SecretsPage,
});

const tokensRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/tokens',
  component: TokensPage,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    prompt?: string;
    send?: string;
    agent?: string;
    app?: string;
    category?: string;
    kind?: string;
  } => {
    const prompt = optionalStringSearchValue(search.prompt);
    const send = optionalStringSearchValue(search.send);
    const agent = optionalStringSearchValue(search.agent);
    const app = optionalStringSearchValue(search.app);
    const category = optionalStringSearchValue(search.category);
    const kind = optionalStringSearchValue(search.kind);
    return {
      ...(prompt ? { prompt } : {}),
      ...(send ? { send } : {}),
      ...(agent ? { agent } : {}),
      ...(app ? { app } : {}),
      ...(category ? { category } : {}),
      ...(kind ? { kind } : {}),
    };
  },
  component: ChatRouteComponent,
});

const chatSessionRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: '$sessionId',
});

const appsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/apps',
  component: AppsRouteComponent,
});

const routeTree = rootRoute.addChildren([
  adminLayoutRoute.addChildren([
    dashboardRoute,
    statisticsRoute,
    approvalsRoute,
    a2aInboxRoute,
    a2aTrustRoute,
    agentFilesRoute,
    agentScoreboardRoute,
    terminalRoute,
    gatewayRoute,
    logsRoute,
    fleetTopologyRoute,
    sessionsRoute,
    channelsRoute,
    teamsRoute,
    emailRoute,
    configRoute,
    modelsRoute,
    schedulerRoute,
    jobsRoute,
    harnessEvolutionRoute,
    distillRoute,
    connectorsRoute,
    mcpRoute,
    auditRoute,
    skillsRoute,
    skillDetailRoute,
    pluginsRoute,
    outputGuardRoute,
    toolsRoute,
    secretsRoute,
    tokensRoute,
  ]),
  agentsOverviewRoute,
  chatRoute.addChildren([chatSessionRoute]),
  appsRoute,
]);

export const router = createRouter({
  routeTree,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
