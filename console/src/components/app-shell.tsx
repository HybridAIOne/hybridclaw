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
} from './sidebar/index';
import { SIDEBAR_NAV_GROUPS } from './sidebar/navigation';
import { ViewSwitchNav } from './view-switch';

const SIDEBAR_STYLE = getSidebarStyleVars('15.5rem', '18rem');

type AppShellConfigContextValue = {
  configReady: boolean;
  emailEnabled: boolean;
};

const AppShellConfigContext = createContext<AppShellConfigContextValue>({
  configReady: false,
  emailEnabled: false,
});

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
  const sidebarGroups = SIDEBAR_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.requiresEmail || emailEnabled || pathname === item.to,
    ),
  })).filter((group) => group.items.length > 0);
  const currentNavItem = resolveCurrentAdminNavItem(pathname);

  return (
    <AppShellConfigContext.Provider value={{ configReady, emailEnabled }}>
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

export function useAppShellConfig(): AppShellConfigContextValue {
  return useContext(AppShellConfigContext);
}
