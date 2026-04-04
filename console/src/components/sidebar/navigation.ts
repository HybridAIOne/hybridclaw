import type { ComponentType } from 'react';
import {
  Audit,
  Channels,
  Config,
  Dashboard,
  Gateway,
  Jobs,
  Models,
  Plugins,
  Scheduler,
  Sessions,
  Skills,
  Terminal,
  Tools,
} from './icons';

export type SidebarNavItem = {
  to: string;
  label: string;
  icon: ComponentType;
  section: 'overview' | 'runtime' | 'configuration';
};

export const SIDEBAR_NAV_ITEMS: ReadonlyArray<SidebarNavItem> = [
  { to: '/', label: 'Dashboard', icon: Dashboard, section: 'overview' },
  { to: '/audit', label: 'Audit', icon: Audit, section: 'overview' },
  { to: '/jobs', label: 'Jobs', icon: Jobs, section: 'overview' },
  { to: '/terminal', label: 'Terminal', icon: Terminal, section: 'runtime' },
  { to: '/gateway', label: 'Gateway', icon: Gateway, section: 'runtime' },
  { to: '/sessions', label: 'Sessions', icon: Sessions, section: 'runtime' },
  { to: '/channels', label: 'Channels', icon: Channels, section: 'runtime' },
  { to: '/models', label: 'Models', icon: Models, section: 'runtime' },
  { to: '/scheduler', label: 'Scheduler', icon: Scheduler, section: 'runtime' },
  { to: '/mcp', label: 'MCP', icon: Plugins, section: 'runtime' },
  { to: '/skills', label: 'Skills', icon: Skills, section: 'configuration' },
  { to: '/plugins', label: 'Plugins', icon: Plugins, section: 'configuration' },
  { to: '/tools', label: 'Tools', icon: Tools, section: 'configuration' },
  { to: '/config', label: 'Config', icon: Config, section: 'configuration' },
];
