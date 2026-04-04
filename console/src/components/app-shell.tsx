import { Link, useRouterState } from '@tanstack/react-router';
import type { ComponentType, ReactNode } from 'react';
import { useAuth } from '../auth';
import { ThemeToggle } from './theme-toggle';
import { Admin, Agents, Chat, Docs, Github } from './icons';

const NAV_ITEMS: ReadonlyArray<{
  to: string;
  label: string;
  icon?: ComponentType;
}> = [
  { to: '/', label: 'Dashboard' },
  { to: '/terminal', label: 'Terminal' },
  { to: '/gateway', label: 'Gateway' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/channels', label: 'Channels' },
  { to: '/models', label: 'Models' },
  { to: '/scheduler', label: 'Scheduler' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/mcp', label: 'MCP' },
  { to: '/audit', label: 'Audit' },
  { to: '/skills', label: 'Skills' },
  { to: '/plugins', label: 'Plugins' },
  { to: '/tools', label: 'Tools' },
  { to: '/config', label: 'Config' },
];

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
    NAV_ITEMS.find((item) => item.to === adminPath) || NAV_ITEMS[0];

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div>
          <div className="brand-block">
            <p className="eyebrow">HybridClaw</p>
            <div className="brand-title">
              <span className="nav-link-icon" aria-hidden="true">
                <Admin />
              </span>
              <h1>Admin console</h1>
            </div>
          </div>

          <nav className="nav-group" aria-label="Primary">
            {NAV_ITEMS.map((item) => {
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  activeProps={{ className: 'nav-link active' }}
                  inactiveProps={{ className: 'nav-link' }}
                  activeOptions={{ exact: item.to === '/' }}
                >
                  {item.icon ? (
                    <span className="nav-link-icon" aria-hidden="true">
                      <item.icon />
                    </span>
                  ) : null}
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-footer">
          {auth.gatewayStatus?.version ? (
            <span className="meta-chip sidebar-meta-chip">
              {auth.gatewayStatus.version}
            </span>
          ) : null}
          <div className="sidebar-footer-right">
            <ThemeToggle />
            {auth.token ? (
              <button
                className="ghost-button"
                type="button"
                onClick={auth.logout}
              >
                Forget token
              </button>
            ) : null}
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <div className="topbar">
          <div className="topbar-title">
            <h2>{currentNavItem.label}</h2>
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
      </main>
    </div>
  );
}
