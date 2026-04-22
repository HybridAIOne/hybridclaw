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

function isOnAdminChat(pathname: string): boolean {
  return pathname === '/admin/chat' || pathname.startsWith('/admin/chat/');
}

function pathMatches(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function isItemActive(pathname: string, item: ViewSwitchItem): boolean {
  // The React /admin/chat route is part of the chat experience, so the
  // "Chat" tab (not the "Admin" tab) should highlight — matching static
  // /chat's active-tab behavior.
  const onAdminChat = isOnAdminChat(pathname);
  if (item.external) {
    if (item.href === '/chat') {
      return onAdminChat || pathMatches(pathname, '/chat');
    }
    if (item.href === '/agents') return pathMatches(pathname, '/agents');
    return false;
  }
  if (item.to === '/admin') {
    return !onAdminChat && pathMatches(pathname, '/admin');
  }
  return pathMatches(pathname, item.to);
}

export function ViewSwitchNav() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <nav className="view-switch" aria-label="Switch view">
      {VIEW_SWITCH_ITEMS.map((item) => {
        const active = isItemActive(pathname, item);
        const linkClass = active
          ? 'view-switch-link active'
          : 'view-switch-link';
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
              className={linkClass}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              target={isCrossOrigin ? '_blank' : undefined}
              rel={isCrossOrigin ? 'noopener noreferrer' : undefined}
            >
              {inner}
            </a>
          );
        }
        return active ? (
          <span key={item.to} className={linkClass} aria-current="page">
            {inner}
          </span>
        ) : (
          <Link key={item.to} className={linkClass} to={item.to}>
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}
