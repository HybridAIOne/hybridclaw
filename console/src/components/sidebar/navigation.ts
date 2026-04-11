import type { ComponentType } from 'react';
import {
  Audit,
  Channels,
  Cog,
  Config,
  Dashboard,
  Email,
  Gateway,
  Jobs,
  Models,
  Plugins,
  Scheduler,
  Sessions,
  Skills,
  Terminal,
  Tools,
} from '../icons';

export type SidebarNavItem = {
  to: string;
  label: string;
  icon: ComponentType;
  requiresEmail?: boolean;
};

export type SidebarNavGroup = {
  label: string;
  items: ReadonlyArray<SidebarNavItem>;
};

export const SIDEBAR_NAV_GROUPS: ReadonlyArray<SidebarNavGroup> = [
  {
    label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: Dashboard },
      { to: '/audit', label: 'Audit', icon: Audit },
      { to: '/jobs', label: 'Jobs', icon: Jobs },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { to: '/terminal', label: 'Terminal', icon: Terminal },
      { to: '/gateway', label: 'Gateway', icon: Gateway },
      { to: '/sessions', label: 'Sessions', icon: Sessions },
      { to: '/channels', label: 'Channels', icon: Channels },
      { to: '/email', label: 'Email', icon: Email, requiresEmail: true },
      { to: '/models', label: 'Models', icon: Models },
      { to: '/scheduler', label: 'Scheduler', icon: Scheduler },
      { to: '/mcp', label: 'MCP', icon: Cog },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/skills', label: 'Skills', icon: Skills },
      { to: '/plugins', label: 'Plugins', icon: Plugins },
      { to: '/tools', label: 'Tools', icon: Tools },
      { to: '/config', label: 'Config', icon: Config },
    ],
  },
];
