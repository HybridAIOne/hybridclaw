import type { ComponentType } from 'react';
import { Admin, Agents, Chat, Docs, Github } from './icons';

const VIEW_SWITCH_ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  icon: ComponentType;
  matchPrefix?: string;
}> = [
  { href: '/chat', label: 'Chat', icon: Chat, matchPrefix: '/chat' },
  { href: '/agents', label: 'Agents', icon: Agents, matchPrefix: '/agents' },
  { href: '/admin', label: 'Admin', icon: Admin, matchPrefix: '/admin' },
  {
    href: 'https://github.com/HybridAIOne/hybridclaw',
    label: 'GitHub',
    icon: Github,
  },
  { href: '/development', label: 'Docs', icon: Docs },
];

function isActive(pathname: string, matchPrefix: string | undefined): boolean {
  if (!matchPrefix) return false;
  return pathname === matchPrefix || pathname.startsWith(`${matchPrefix}/`);
}

export function ViewSwitchNav() {
  const pathname =
    typeof window === 'undefined' ? '' : window.location.pathname;

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
        return isActive(pathname, item.matchPrefix) ? (
          <span
            key={item.href}
            className="view-switch-link active"
            aria-current="page"
          >
            {inner}
          </span>
        ) : (
          <a key={item.href} className="view-switch-link" href={item.href}>
            {inner}
          </a>
        );
      })}
    </nav>
  );
}
