import { Link, useRouterState } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { Admin, Agents, Chat, Docs, Github } from './icons';

type ViewSwitchItem = {
  label: string;
  icon: ComponentType;
} & (
  | { href: string; external: true }
  | { to: string; external?: false }
);

const VIEW_SWITCH_ITEMS: ReadonlyArray<ViewSwitchItem> = [
  { to: '/chat', label: 'Chat', icon: Chat },
  { to: '/agents', label: 'Agents', icon: Agents },
  { to: '/admin', label: 'Admin', icon: Admin },
  {
    href: 'https://github.com/HybridAIOne/hybridclaw',
    label: 'GitHub',
    icon: Github,
    external: true,
  },
  { to: '/development', label: 'Docs', icon: Docs },
];

function isActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function ViewSwitchNav() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
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
        if (item.external) {
          return (
            <a
              key={item.href}
              className="view-switch-link"
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {inner}
            </a>
          );
        }
        const active = isActive(pathname, item.to);
        return active ? (
          <span
            key={item.to}
            className="view-switch-link active"
            aria-current="page"
          >
            {inner}
          </span>
        ) : (
          <Link key={item.to} className="view-switch-link" to={item.to}>
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}
