import type { AppViewIconKind } from './icons';

export type SidebarNavItem = {
  to: string;
  label: string;
  icon: AppViewIconKind;
  section: 'overview' | 'runtime' | 'configuration';
};

export const SIDEBAR_NAV_ITEMS: ReadonlyArray<SidebarNavItem> = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', section: 'overview' },
  { to: '/audit', label: 'Audit', icon: 'audit', section: 'overview' },
  { to: '/jobs', label: 'Jobs', icon: 'jobs', section: 'overview' },
  { to: '/terminal', label: 'Terminal', icon: 'terminal', section: 'runtime' },
  { to: '/gateway', label: 'Gateway', icon: 'gateway', section: 'runtime' },
  { to: '/sessions', label: 'Sessions', icon: 'sessions', section: 'runtime' },
  { to: '/channels', label: 'Channels', icon: 'channels', section: 'runtime' },
  { to: '/models', label: 'Models', icon: 'models', section: 'runtime' },
  { to: '/scheduler', label: 'Scheduler', icon: 'scheduler', section: 'runtime' },
  { to: '/mcp', label: 'MCP', icon: 'plugins', section: 'runtime' },
  { to: '/skills', label: 'Skills', icon: 'skills', section: 'configuration' },
  { to: '/plugins', label: 'Plugins', icon: 'plugins', section: 'configuration' },
  { to: '/tools', label: 'Tools', icon: 'tools', section: 'configuration' },
  { to: '/config', label: 'Config', icon: 'config', section: 'configuration' },
];
