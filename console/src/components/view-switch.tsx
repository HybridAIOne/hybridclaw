import type { ComponentType } from 'react';
import { Admin, Agents, Chat, Docs, Github } from './icons';

const VIEW_SWITCH_ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  icon: ComponentType;
  active?: true;
}> = [
  { href: '/chat', label: 'Chat', icon: Chat },
  { href: '/agents', label: 'Agents', icon: Agents },
  { href: '/admin', label: 'Admin', icon: Admin, active: true },
  {
    href: 'https://github.com/HybridAIOne/hybridclaw',
    label: 'GitHub',
    icon: Github,
  },
  { href: '/development', label: 'Docs', icon: Docs },
];

export function ViewSwitchNav() {
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
        return item.active ? (
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
