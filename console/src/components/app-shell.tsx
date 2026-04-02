import { useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import { AppSidebar } from './sidebar/app-sidebar';
import { AppViewIcon } from './sidebar/icons';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  getSidebarStyleVars,
} from './sidebar/index';
import { SIDEBAR_NAV_ITEMS } from './sidebar/navigation';

const VIEW_SWITCH_ITEMS = [
  { href: '/chat', label: 'Chat', icon: 'chat' },
  { href: '/agents', label: 'Agents', icon: 'agents' },
  { href: '/admin', label: 'Admin', icon: 'admin' },
  {
    href: 'https://github.com/HybridAIOne/hybridclaw',
    label: 'GitHub',
    icon: 'github',
  },
  { href: '/development', label: 'Docs', icon: 'docs' },
] as const;

export function AppShell(props: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const adminPath = pathname.startsWith('/admin/')
    ? pathname.slice('/admin'.length)
    : pathname === '/admin'
      ? '/'
      : pathname;
  const currentNavItem =
    SIDEBAR_NAV_ITEMS.find((item) => item.to === adminPath) ||
    SIDEBAR_NAV_ITEMS[0];

  return (
    <SidebarProvider style={getSidebarStyleVars('15.5rem', '18rem')}>
      <AppSidebar
        items={SIDEBAR_NAV_ITEMS}
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
              const isActive = item.icon === 'admin';
              const classes = isActive
                ? 'view-switch-link active'
                : 'view-switch-link';

              if (isActive) {
                return (
                  <span key={item.href} className={classes} aria-current="page">
                    <span className="nav-link-icon" aria-hidden="true">
                      <AppViewIcon kind={item.icon} />
                    </span>
                    <span>{item.label}</span>
                  </span>
                );
              }

              return (
                <a key={item.href} className={classes} href={item.href}>
                  <span className="nav-link-icon" aria-hidden="true">
                    <AppViewIcon kind={item.icon} />
                  </span>
                  <span>{item.label}</span>
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
