import { useRouterState } from '@tanstack/react-router';
import type { ComponentType, ReactNode } from 'react';
import { useAuth } from '../auth';
import { Admin, Agents, Chat, Docs, Github } from './icons';
import { AppSidebar } from './sidebar/app-sidebar';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  getSidebarStyleVars,
} from './sidebar/index';
import { SIDEBAR_NAV_ITEMS } from './sidebar/navigation';

const VIEW_SWITCH_ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  icon: ComponentType;
  active?: true;
}> = [
  { href: '/chat', label: 'Chat', icon: Chat },
  { href: '/agents', label: 'Agents', icon: Agents },
  { href: '/admin', label: 'Admin', icon: Admin, active: true },
  { href: 'https://github.com/HybridAIOne/hybridclaw', label: 'GitHub', icon: Github },
  { href: '/development', label: 'Docs', icon: Docs },
];

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
              const classes = item.active
                ? 'view-switch-link active'
                : 'view-switch-link';

              if (item.active) {
                return (
                  <span key={item.href} className={classes} aria-current="page">
                    <span className="nav-link-icon" aria-hidden="true">
                      <item.icon />
                    </span>
                    <span>{item.label}</span>
                  </span>
                );
              }

              return (
                <a key={item.href} className={classes} href={item.href}>
                  <span className="nav-link-icon" aria-hidden="true">
                    <item.icon />
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
