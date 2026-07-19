import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { AppShell } from './components/app-shell';
import { resolveBrowserTitle } from './lib/browser-title';
import { ActivityPage } from './routes/activity';
import { AgentsHubPage } from './routes/agents-hub';
import { ApprovalsPage } from './routes/approvals';
import { AutomationPage } from './routes/automation';
import { ChannelsPage } from './routes/channels';
import { ConfigPage } from './routes/config';
import { ConnectorsPage } from './routes/connectors';
import { CredentialsPage } from './routes/credentials';
import { DashboardPage } from './routes/dashboard';
import { DistillPage } from './routes/distill';
import { EmailPage } from './routes/email';
import { ExtensionsPage } from './routes/extensions';
import { FederationPage } from './routes/federation';
import { GatewayPage } from './routes/gateway';
import { HarnessEvolutionPage } from './routes/harness-evolution';
import { LogsPage } from './routes/logs';
import { McpPage } from './routes/mcp';
import { ModelsPage } from './routes/models';
import { OutputGuardPage } from './routes/output-guard';
import { SkillsDetailPage } from './routes/skill-detail';
import { SkillsPage } from './routes/skills';
import { TeamsPage } from './routes/teams';

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

const legacyAgentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/agents',
      search: { tab: 'scoreboard' },
      replace: true,
    });
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin',
  component: DashboardPage,
});

const activityRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/activity',
  validateSearch: (search: Record<string, unknown>) => {
    const tab = optionalStringSearchValue(search.tab);
    const range = optionalStringSearchValue(search.range);
    const q = optionalStringSearchValue(search.q);
    const sessionId = optionalStringSearchValue(search.sessionId);
    return {
      ...(tab ? { tab } : {}),
      ...(range ? { range } : {}),
      ...(q ? { q } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  },
  component: ActivityPage,
});

const legacyStatisticsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/statistics',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/activity',
      search: { tab: 'usage' },
      replace: true,
    });
  },
});

const networkPolicyRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/network-policy',
  component: ApprovalsPage,
});

const legacyApprovalsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/approvals',
  beforeLoad: () => {
    throw redirect({ to: '/admin/network-policy', replace: true });
  },
});

const federationRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/federation',
  validateSearch: (search: Record<string, unknown>) => {
    const tab = optionalStringSearchValue(search.tab);
    return tab ? { tab } : {};
  },
  component: FederationPage,
});

const legacyA2AInboxRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/a2a-inbox',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/federation',
      search: { tab: 'inbox' },
      replace: true,
    });
  },
});

const legacyA2ATrustRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/a2a-trust',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/federation',
      search: { tab: 'peers' },
      replace: true,
    });
  },
});

const agentsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/agents',
  validateSearch: (search: Record<string, unknown>) => {
    const tab = optionalStringSearchValue(search.tab);
    const agent = optionalStringSearchValue(search.agent);
    const file = optionalStringSearchValue(search.file);
    return {
      ...(tab ? { tab } : {}),
      ...(agent ? { agent } : {}),
      ...(file ? { file } : {}),
    };
  },
  component: AgentsHubPage,
});

const legacyAgentScoreboardRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/agent-scoreboard',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/agents',
      search: { tab: 'scoreboard' },
      replace: true,
    });
  },
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
  beforeLoad: () => {
    throw redirect({
      to: '/admin/federation',
      search: { tab: 'topology' },
      replace: true,
    });
  },
});

const sessionsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/sessions',
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId: optionalStringSearchValue(search.sessionId),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/admin/activity',
      search: { tab: 'sessions', sessionId: search.sessionId },
      replace: true,
    });
  },
});

const channelsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/channels',
  component: ChannelsPage,
});

const legacyTeamsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/teams',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/connectors',
      hash: 'teams-sso',
      replace: true,
    });
  },
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

const automationRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/automation',
  validateSearch: (search: Record<string, unknown>) => {
    const tab = optionalStringSearchValue(search.tab);
    const jobId = optionalStringSearchValue(search.jobId);
    return {
      ...(tab ? { tab } : {}),
      ...(jobId ? { jobId } : {}),
    };
  },
  component: AutomationPage,
});

const schedulerRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/scheduler',
  validateSearch: (search: Record<string, unknown>) => ({
    jobId: optionalStringSearchValue(search.jobId),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/admin/automation',
      search: { tab: 'schedules', jobId: search.jobId },
      replace: true,
    });
  },
});

const jobsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/jobs',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/automation',
      search: { tab: 'work-queue' },
      replace: true,
    });
  },
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

function ConnectorsRouteComponent() {
  const hash = useRouterState({
    select: (state) => state.location.hash.replace(/^#/, ''),
  });

  return hash === 'teams-sso' ? <TeamsPage /> : <ConnectorsPage />;
}

const connectorsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/connectors',
  component: ConnectorsRouteComponent,
});

const auditRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/audit',
  validateSearch: (search: Record<string, unknown>) => {
    const q = optionalStringSearchValue(search.q);
    const range = optionalStringSearchValue(search.range);
    return {
      ...(q ? { q } : {}),
      ...(range ? { range } : {}),
    };
  },
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/admin/activity',
      search: {
        tab: 'audit',
        q: search.q,
        range: search.range,
      },
      replace: true,
    });
  },
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

const extensionsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/extensions',
  validateSearch: (search: Record<string, unknown>) => {
    const tab = optionalStringSearchValue(search.tab);
    return tab ? { tab } : {};
  },
  component: ExtensionsPage,
});

const pluginsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/plugins',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/extensions',
      search: { tab: 'plugins' },
      replace: true,
    });
  },
});

const outputGuardRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/output-guard',
  component: OutputGuardPage,
});

const toolsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/tools',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/extensions',
      search: { tab: 'tools' },
      replace: true,
    });
  },
});

const credentialsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/credentials',
  validateSearch: (search: Record<string, unknown>) => {
    const tab = optionalStringSearchValue(search.tab);
    return tab ? { tab } : {};
  },
  component: CredentialsPage,
});

const secretsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/secrets',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/credentials',
      search: { tab: 'secrets' },
      replace: true,
    });
  },
});

const tokensRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/admin/tokens',
  beforeLoad: () => {
    throw redirect({
      to: '/admin/credentials',
      search: { tab: 'api-tokens' },
      replace: true,
    });
  },
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
    activityRoute,
    legacyStatisticsRoute,
    networkPolicyRoute,
    legacyApprovalsRoute,
    federationRoute,
    legacyA2AInboxRoute,
    legacyA2ATrustRoute,
    agentsRoute,
    legacyAgentScoreboardRoute,
    terminalRoute,
    gatewayRoute,
    logsRoute,
    fleetTopologyRoute,
    sessionsRoute,
    channelsRoute,
    legacyTeamsRoute,
    emailRoute,
    configRoute,
    modelsRoute,
    automationRoute,
    schedulerRoute,
    jobsRoute,
    harnessEvolutionRoute,
    distillRoute,
    connectorsRoute,
    mcpRoute,
    auditRoute,
    skillsRoute,
    skillDetailRoute,
    extensionsRoute,
    pluginsRoute,
    outputGuardRoute,
    toolsRoute,
    credentialsRoute,
    secretsRoute,
    tokensRoute,
  ]),
  legacyAgentsRoute,
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
