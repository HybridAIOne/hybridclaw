import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { createContext, type ReactNode, useContext } from 'react';
import { fetchConfig } from '../api/client';
import { useAuth } from '../auth';
import { resolveCurrentAdminNavItem } from './admin-nav';
import { AppSidebar } from './sidebar/app-sidebar';
import {
  getSidebarStyleVars,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from './sidebar/index';
import { SIDEBAR_NAV_GROUPS } from './sidebar/navigation';
import { ViewSwitchNav } from './view-switch';

// The /admin/chat route renders its own full layout (chat sidebar + right
// column with topbar). AppShell just provides the outer full-height shell so
// the admin sidebar and page title don't appear.

const SIDEBAR_STYLE = getSidebarStyleVars('15.5rem', '18rem');

type AppShellConfigContextValue = {
  configReady: boolean;
  emailEnabled: boolean;
};

const AppShellConfigContext = createContext<AppShellConfigContextValue>({
  configReady: false,
  emailEnabled: false,
});

function isChatRoute(pathname: string): boolean {
  return pathname === '/admin/chat' || pathname.startsWith('/admin/chat/');
}

export function AppShell(props: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });
  const configReady = Boolean(configQuery.data);
  const emailEnabled = configQuery.data?.config.email.enabled === true;
  const onChatRoute = isChatRoute(pathname);

  const configContextValue = { configReady, emailEnabled };

  if (onChatRoute) {
    // Chat has its own full layout (sidebar + right column with an inline
    // topbar). AppShell only provides the outer full-height shell; the
    // topbar (ContextRing + ViewSwitchNav) is rendered inside ChatPage so
    // the sidebar can span the entire page height as in static /chat.
    return (
      <AppShellConfigContext.Provider value={configContextValue}>
        <div className="chat-shell">{props.children}</div>
      </AppShellConfigContext.Provider>
    );
  }

  const sidebarGroups = SIDEBAR_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.requiresEmail || emailEnabled || pathname === item.to,
    ),
  })).filter((group) => group.items.length > 0);
  const currentNavItem = resolveCurrentAdminNavItem(pathname);

  return (
    <AppShellConfigContext.Provider value={configContextValue}>
      <SidebarProvider style={SIDEBAR_STYLE}>
        <AppSidebar
          groups={sidebarGroups}
          version={auth.gatewayStatus?.version}
          showLogout={Boolean(auth.token)}
          onLogout={auth.logout}
        />
        <SidebarInset className="main-panel">
          <div className="topbar">
            <div className="topbar-title">
              <div className="topbar-heading">
                <MobileTopbarTrigger />
                <h2>{currentNavItem.label}</h2>
              </div>
            </div>
            <ViewSwitchNav />
          </div>
          <div className="page-content">{props.children}</div>
        </SidebarInset>
      </SidebarProvider>
    </AppShellConfigContext.Provider>
  );
}

function MobileTopbarTrigger() {
  const { isMobile } = useSidebar();
  if (!isMobile) return null;
  return <SidebarTrigger />;
}

export function useAppShellConfig(): AppShellConfigContextValue {
  return useContext(AppShellConfigContext);
}
