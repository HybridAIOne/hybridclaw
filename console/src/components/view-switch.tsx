import { Link, useRouterState } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { Admin, Agents, Chat, Circle, Docs, Github } from './icons';

export type ViewSwitchItem = {
  label: string;
  href: string;
};

const DEFAULT_VIEW_SWITCH_ITEMS: ReadonlyArray<ViewSwitchItem> = [
  { href: '/chat', label: 'Chat' },
  { href: '/agents', label: 'Agents' },
  { href: '/admin', label: 'Admin' },
  {
    href: 'https://github.com/HybridAIOne/hybridclaw',
    label: 'GitHub',
  },
  { href: '/docs', label: 'Docs' },
];

function isActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function isExternalHref(href: string): boolean {
  return /^https?:\/\//iu.test(href);
}

function isSpaHref(href: string): boolean {
  return (
    href === '/admin' ||
    href.startsWith('/admin/') ||
    href === '/agents' ||
    href.startsWith('/agents/') ||
    href === '/chat' ||
    href.startsWith('/chat/')
  );
}

function hostnameMatches(href: string, hostname: string): boolean {
  try {
    return new URL(href).hostname.toLowerCase() === hostname;
  } catch {
    return false;
  }
}

function iconForItem(item: ViewSwitchItem): ComponentType {
  const label = item.label.trim().toLowerCase();
  const href = item.href.trim().toLowerCase();
  if (href === '/chat' || label === 'chat') return Chat;
  if (href === '/agents' || label === 'agents') return Agents;
  if (href === '/admin' || label === 'admin') return Admin;
  if (href === '/docs' || label === 'docs') return Docs;
  if (hostnameMatches(item.href, 'github.com') || label === 'github') {
    return Github;
  }
  return Circle;
}

function resolveActiveHref(
  pathname: string,
  items: ReadonlyArray<ViewSwitchItem>,
): string | null {
  return (
    items
      .filter((item) => !isExternalHref(item.href) && isActive(pathname, item.href))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null
  );
}

export function ViewSwitchNav(props: { items?: ReadonlyArray<ViewSwitchItem> }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const items = props.items ?? DEFAULT_VIEW_SWITCH_ITEMS;
  if (items.length === 0) return null;
  const activeHref = resolveActiveHref(pathname, items);

  return (
    <nav className="view-switch" aria-label="Switch view">
      {items.map((item, index) => {
        const Icon = iconForItem(item);
        const key = `${item.href}:${item.label}:${index}`;
        const inner = (
          <>
            <span className="nav-link-icon" aria-hidden="true">
              <Icon />
            </span>
            <span>{item.label}</span>
          </>
        );
        const external = isExternalHref(item.href);
        if (external || !isSpaHref(item.href)) {
          const active = item.href === activeHref;
          return (
            <a
              key={key}
              className={
                active ? 'view-switch-link active' : 'view-switch-link'
              }
              href={item.href}
              aria-current={active ? 'page' : undefined}
              target={external ? '_blank' : undefined}
              rel={external ? 'noopener noreferrer' : undefined}
            >
              {inner}
            </a>
          );
        }
        const active = item.href === activeHref;
        return active ? (
          <span
            key={key}
            className="view-switch-link active"
            aria-current="page"
          >
            {inner}
          </span>
        ) : (
          <Link key={key} className="view-switch-link" to={item.href}>
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}
