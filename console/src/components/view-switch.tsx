import { Link, useRouterState } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { Admin, Agents, Chat, Circle, Docs } from './icons';

type ViewSwitchIcon = 'admin' | 'agents' | 'chat' | 'docs';

export type ViewSwitchItem = {
  label: string;
  href: string;
  icon?: ViewSwitchIcon;
  image?: string;
};

export const DEFAULT_VIEW_SWITCH_ITEMS: ReadonlyArray<ViewSwitchItem> = [
  { href: '/chat', icon: 'chat', label: 'Chat' },
  { href: '/agents', icon: 'agents', label: 'Agents' },
  { href: '/admin', icon: 'admin', label: 'Admin' },
  {
    href: 'https://github.com/HybridAIOne/hybridclaw',
    image: '/icons/github.svg',
    label: 'GitHub',
  },
  { href: '/docs', icon: 'docs', label: 'Docs' },
];

const VIEW_SWITCH_ICONS: Record<ViewSwitchIcon, ComponentType> = {
  admin: Admin,
  agents: Agents,
  chat: Chat,
  docs: Docs,
};

const SPA_NAVIGATION_PREFIXES = ['/admin', '/agents', '/chat'] as const;

function isActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function isExternalHref(href: string): boolean {
  return /^https?:\/\//iu.test(href);
}

function isSpaHref(href: string): boolean {
  // Keep configured links inside known console route families on the SPA
  // router; other local paths intentionally fall back to normal anchors.
  return SPA_NAVIGATION_PREFIXES.some(
    (prefix) => href === prefix || href.startsWith(`${prefix}/`),
  );
}

function NavigationMark({ item }: { item: ViewSwitchItem }) {
  if (item.image) {
    return (
      <img
        src={item.image}
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable={false}
        referrerPolicy="no-referrer"
      />
    );
  }

  const Icon = item.icon ? VIEW_SWITCH_ICONS[item.icon] : Circle;
  return <Icon />;
}

function resolveActiveHref(
  pathname: string,
  items: ReadonlyArray<ViewSwitchItem>,
): string | null {
  return (
    items
      .filter(
        (item) => !isExternalHref(item.href) && isActive(pathname, item.href),
      )
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null
  );
}

export function ViewSwitchNav(props: {
  items?: ReadonlyArray<ViewSwitchItem>;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const items = props.items ?? DEFAULT_VIEW_SWITCH_ITEMS;
  if (items.length === 0) return null;
  const activeHref = resolveActiveHref(pathname, items);

  return (
    <nav className="view-switch" aria-label="Switch view">
      {items.map((item, index) => {
        const key = `${item.href}:${item.label}:${index}`;
        const inner = (
          <>
            <span className="nav-link-icon" aria-hidden="true">
              <NavigationMark item={item} />
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
