import { Link, useRouterState } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { Admin, Agents, Chat, Docs, Github } from './icons';

type ViewSwitchItem = {
  label: string;
  icon: ComponentType;
} & ({ href: string; external: true } | { to: string; external?: false });

const VIEW_SWITCH_ITEMS: ReadonlyArray<ViewSwitchItem> = [
  { href: '/chat', label: 'Chat', icon: Chat, external: true },
  { href: '/agents', label: 'Agents', icon: Agents, external: true },
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
          const isCrossOrigin = /^https?:\/\//i.test(item.href);
          return (
            <a
              key={item.href}
              className="view-switch-link"
              href={item.href}
              target={isCrossOrigin ? '_blank' : undefined}
              rel={isCrossOrigin ? 'noopener noreferrer' : undefined}
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
