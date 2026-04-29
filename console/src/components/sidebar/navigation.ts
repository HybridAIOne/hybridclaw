import type { ComponentType } from 'react';
import {
  AgentGroup,
  Audit,
  Channels,
  Cog,
  Config,
  Dashboard,
  Email,
  Files,
  Gateway,
  Jobs,
  Models,
  Plugins,
  Policy,
  Scheduler,
  Sessions,
  Skills,
  Statistics,
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
      { to: '/admin', label: 'Dashboard', icon: Dashboard },
      { to: '/admin/statistics', label: 'Statistics', icon: Statistics },
      { to: '/admin/approvals', label: 'Approvals', icon: Policy },
      { to: '/admin/audit', label: 'Audit', icon: Audit },
      { to: '/admin/jobs', label: 'Jobs', icon: Jobs },
      { to: '/admin/workflows', label: 'Workflows', icon: Scheduler },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { to: '/admin/terminal', label: 'Terminal', icon: Terminal },
      { to: '/admin/gateway', label: 'Gateway', icon: Gateway },
      { to: '/admin/sessions', label: 'Sessions', icon: Sessions },
      { to: '/admin/channels', label: 'Channels', icon: Channels },
      { to: '/admin/email', label: 'Email', icon: Email, requiresEmail: true },
      { to: '/admin/models', label: 'Models', icon: Models },
      { to: '/admin/scheduler', label: 'Scheduler', icon: Scheduler },
      { to: '/admin/mcp', label: 'MCP', icon: Cog },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/admin/agents', label: 'Agent Files', icon: Files },
      { to: '/admin/agent-scoreboard', label: 'Agents', icon: AgentGroup },
      { to: '/admin/skills', label: 'Skills', icon: Skills },
      { to: '/admin/plugins', label: 'Plugins', icon: Plugins },
      { to: '/admin/tools', label: 'Tools', icon: Tools },
      { to: '/admin/config', label: 'Config', icon: Config },
    ],
  },
];
