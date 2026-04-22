import { Link, useRouterState } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { Admin, Agents, Chat, Docs, Github } from './icons';

type ViewSwitchItem = {
  label: string;
  icon: ComponentType;
} & ({ href: string; external?: boolean } | { to: string; external?: false });

const VIEW_SWITCH_ITEMS: ReadonlyArray<ViewSwitchItem> = [
  { to: '/chat', label: 'Chat', icon: Chat },
  { href: '/agents', label: 'Agents', icon: Agents },
  { to: '/admin', label: 'Admin', icon: Admin },
  {
    href: 'https://github.com/HybridAIOne/hybridclaw',
    label: 'GitHub',
    icon: Github,
    external: true,
  },
  { href: '/development', label: 'Docs', icon: Docs },
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
        if ('href' in item) {
          const active = !item.external && isActive(pathname, item.href);
          return (
            <a
              key={item.href}
              className={
                active ? 'view-switch-link active' : 'view-switch-link'
              }
              href={item.href}
              aria-current={active ? 'page' : undefined}
              target={item.external ? '_blank' : undefined}
              rel={item.external ? 'noopener noreferrer' : undefined}
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
