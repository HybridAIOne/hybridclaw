import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { createContext, type ReactNode, useContext } from 'react';
import { validateToken } from '../api/client';
import { isAuthReadyForApi, useAuth } from '../auth';
import { resolveCurrentAdminNavItem } from './admin-nav';
import { AppSidebar } from './sidebar/app-sidebar';
import {
  getSidebarStyleVars,
  MobileTopbarTrigger,
  SidebarInset,
  SidebarProvider,
} from './sidebar/index';
import { SIDEBAR_NAV_GROUPS } from './sidebar/navigation';
import { useConfiguredViewSwitchItems, ViewSwitchNav } from './view-switch';

const SIDEBAR_STYLE = getSidebarStyleVars('15.5rem', '18rem');

type AppShellConfigContextValue = {
  emailEnabled: boolean;
};

const AppShellConfigContext = createContext<AppShellConfigContextValue>({
  emailEnabled: false,
});

export function AppShell(props: { children: ReactNode }) {
  const auth = useAuth();
  const authReady = isAuthReadyForApi(auth);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const statusQuery = useQuery({
    queryKey: ['status', auth.token],
    queryFn: () => validateToken(auth.token),
    initialData: auth.gatewayStatus ?? undefined,
    enabled: authReady,
    staleTime: 30_000,
  });
  const viewSwitchItems = useConfiguredViewSwitchItems(auth.token);
  const emailEnabled =
    (statusQuery.data?.emailEnabled ?? auth.gatewayStatus?.emailEnabled) ===
    true;
  const sidebarGroups = SIDEBAR_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.requiresEmail || emailEnabled || pathname === item.to,
    ),
  })).filter((group) => group.items.length > 0);
  const currentNavItem = resolveCurrentAdminNavItem(pathname);

  return (
    <AppShellConfigContext.Provider value={{ emailEnabled }}>
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
            <ViewSwitchNav items={viewSwitchItems} />
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
