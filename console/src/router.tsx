import { QueryErrorResetBoundary } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import type { ErrorInfo, ReactNode } from 'react';
import { Component, lazy, Suspense } from 'react';
import { AppShell } from './components/app-shell';
import { AgentFilesPage } from './routes/agents';
import { ApprovalsPage } from './routes/approvals';
import { AuditPage } from './routes/audit';
import { ChannelsPage } from './routes/channels';
import { ConfigPage } from './routes/config';
import { DashboardPage } from './routes/dashboard';
import { EmailPage } from './routes/email';
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

const LazyChatPage = lazy(async () => {
  const mod = await import('./routes/chat');
  return { default: mod.ChatPage };
});

class ChatErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) {
    return { error: err.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Chat page error:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          className="empty-state"
          style={{ textAlign: 'center', padding: '48px 24px' }}
        >
          <p>Something went wrong loading the chat.</p>
          <p style={{ fontSize: '0.84rem', color: 'var(--muted-foreground)' }}>
            {this.state.error}
          </p>
          <button
            type="button"
            className="ghost-button"
            style={{ marginTop: 12 }}
            onClick={() => {
              this.props.onReset?.();
              this.setState({ error: null });
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ChatRouteComponent() {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ChatErrorBoundary onReset={reset}>
          <Suspense fallback={<div className="empty-state">Loading chat…</div>}>
            <LazyChatPage />
          </Suspense>
        </ChatErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}

function RootLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/approvals',
  component: ApprovalsPage,
});

const agentFilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  component: AgentFilesPage,
});

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terminal',
  component: TerminalRouteComponent,
});

const gatewayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gateway',
  component: GatewayPage,
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsPage,
});

const channelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/channels',
  component: ChannelsPage,
});

const emailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/email',
  component: EmailPage,
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
  component: SchedulerPage,
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
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

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: ChatRouteComponent,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  approvalsRoute,
  agentFilesRoute,
  terminalRoute,
  gatewayRoute,
  sessionsRoute,
  channelsRoute,
  emailRoute,
  configRoute,
  modelsRoute,
  schedulerRoute,
  jobsRoute,
  mcpRoute,
  auditRoute,
  skillsRoute,
  pluginsRoute,
  toolsRoute,
  chatRoute,
]);

export const router = createRouter({
  basepath: '/admin',
  routeTree,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
