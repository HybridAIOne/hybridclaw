import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAuth } from '../auth';

function ViewIcon(props: {
  kind: 'chat' | 'agents' | 'admin' | 'cog' | 'docs' | 'github';
}) {
  if (props.kind === 'chat') {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    );
  }

  if (props.kind === 'agents') {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </svg>
    );
  }

  if (props.kind === 'admin') {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 3l7 4v10l-7 4-7-4V7l7-4z" />
        <path d="M12 8v8" />
        <path d="M8.5 10 12 8l3.5 2" />
      </svg>
    );
  }

  if (props.kind === 'docs') {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      </svg>
    );
  }

  if (props.kind === 'github') {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 16 16"
        fill="currentColor"
      >
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 2.75v2.5" />
      <path d="M12 18.75v2.5" />
      <path d="m4.93 4.93 1.77 1.77" />
      <path d="m17.3 17.3 1.77 1.77" />
      <path d="M2.75 12h2.5" />
      <path d="M18.75 12h2.5" />
      <path d="m4.93 19.07 1.77-1.77" />
      <path d="m17.3 6.7 1.77-1.77" />
    </svg>
  );
}

const NAV_ITEMS: ReadonlyArray<{
  to: string;
  label: string;
  icon?: 'cog' | 'chat' | 'agents' | 'admin';
}> = [
  { to: '/', label: 'Dashboard' },
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
  { to: '/config', label: 'Config', icon: 'cog' },
];

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
  const isLocalhostAccess = !auth.gatewayStatus?.webAuthConfigured;
  const sidebarStatusText = isLocalhostAccess
    ? 'localhost access'
    : auth.gatewayStatus?.version || 'token required';

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div>
          <div className="brand-block">
            <p className="eyebrow">HybridClaw</p>
            <div className="brand-title">
              <span className="nav-link-icon" aria-hidden="true">
                <ViewIcon kind="admin" />
              </span>
              <h1>Admin console</h1>
            </div>
            <div
              className={
                isLocalhostAccess
                  ? 'status-pill status-pill-success'
                  : 'status-pill'
              }
            >
              <span
                className={
                  isLocalhostAccess
                    ? 'status-dot status-dot-success'
                    : 'status-dot'
                }
              />
              {sidebarStatusText}
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
                      <ViewIcon kind={item.icon} />
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
      </aside>

      <main className="main-panel">
        <div className="topbar topbar-compact">
          <div className="topbar-actions">
            <nav className="view-switch" aria-label="Switch view">
              {VIEW_SWITCH_ITEMS.map((item) => {
                const isActive = item.icon === 'admin';
                const classes = isActive
                  ? 'view-switch-link active'
                  : 'view-switch-link';

                if (isActive) {
                  return (
                    <span
                      key={item.href}
                      className={classes}
                      aria-current="page"
                    >
                      <span className="nav-link-icon" aria-hidden="true">
                        <ViewIcon kind={item.icon} />
                      </span>
                      <span>{item.label}</span>
                    </span>
                  );
                }

                return (
                  <a key={item.href} className={classes} href={item.href}>
                    <span className="nav-link-icon" aria-hidden="true">
                      <ViewIcon kind={item.icon} />
                    </span>
                    <span>{item.label}</span>
                  </a>
                );
              })}
            </nav>
          </div>
        </div>
        <div className="page-content">{props.children}</div>
      </main>
    </div>
  );
}
