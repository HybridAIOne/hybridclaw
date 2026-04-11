import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { fetchConfig } from '../api/client';
import { useAuth } from '../auth';
import { Admin, Agents, Chat, Docs, Github } from './icons';
import { AppSidebar } from './sidebar/app-sidebar';
import {
  getSidebarStyleVars,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from './sidebar/index';
import { SIDEBAR_NAV_GROUPS } from './sidebar/navigation';

const ALL_NAV_ITEMS = SIDEBAR_NAV_GROUPS.flatMap((group) => group.items);
const SIDEBAR_STYLE = getSidebarStyleVars('15.5rem', '18rem');

const VIEW_SWITCH_ITEMS = [
  { href: '/chat', label: 'Chat', icon: Chat },
  { href: '/agents', label: 'Agents', icon: Agents },
  { href: '/admin', label: 'Admin', icon: Admin, active: true },
  {
    href: 'https://github.com/HybridAIOne/hybridclaw',
    label: 'GitHub',
    icon: Github,
  },
  { href: '/development', label: 'Docs', icon: Docs },
] as const;

export function AppShell(props: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });
  const adminPath = pathname.startsWith('/admin/')
    ? pathname.slice('/admin'.length)
    : pathname === '/admin'
      ? '/'
      : pathname;
  const emailEnabled = configQuery.data?.config.email.enabled === true;
  const sidebarGroups = SIDEBAR_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.requiresEmail || emailEnabled || adminPath === item.to,
    ),
  })).filter((group) => group.items.length > 0);
  const navItems = sidebarGroups.flatMap((group) => group.items);
  const currentNavItem =
    navItems.find((item) => item.to === adminPath) ?? ALL_NAV_ITEMS[0];

  return (
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
              <SidebarTrigger className="topbar-sidebar-trigger" />
              <h2>{currentNavItem.label}</h2>
            </div>
          </div>
          <nav className="view-switch" aria-label="Switch view">
            {VIEW_SWITCH_ITEMS.map((item) => {
              const inner = (
                <>
                  <span className="nav-link-icon" aria-hidden="true">
                    <item.icon />
                  </span>
                  <span>{item.label}</span>
                </>
              );
              return item.active ? (
                <span
                  key={item.href}
                  className="view-switch-link active"
                  aria-current="page"
                >
                  {inner}
                </span>
              ) : (
                <a
                  key={item.href}
                  className="view-switch-link"
                  href={item.href}
                >
                  {inner}
                </a>
              );
            })}
          </nav>
        </div>
        <div className="page-content">{props.children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
