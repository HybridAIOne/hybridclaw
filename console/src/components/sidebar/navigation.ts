import type { ComponentType } from 'react';
import {
  ADMIN_CONFIG_SECTION_OWNERS,
  type AdminConfigSectionOwner,
} from '../../lib/admin-config-owners';
import {
  AgentGroup,
  Channels,
  Cog,
  Config,
  Dashboard,
  Flask,
  Gateway,
  Harness,
  Jobs,
  Lightbulb,
  Logs,
  Models,
  Network,
  Plugins,
  Policy,
  Secrets,
  Share,
  Statistics,
  Terminal,
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
  defaultCollapsed?: boolean;
};

export type { AdminConfigSectionOwner };
export { ADMIN_CONFIG_SECTION_OWNERS };

export const SIDEBAR_NAV_GROUPS: ReadonlyArray<SidebarNavGroup> = [
  {
    label: 'Overview',
    items: [
      { to: '/admin', label: 'Dashboard', icon: Dashboard },
      { to: '/admin/activity', label: 'Activity', icon: Statistics },
    ],
  },
  {
    label: 'Agents',
    items: [
      {
        to: '/admin/agents',
        label: 'Agents',
        icon: AgentGroup,
      },
      { to: '/admin/skills', label: 'Skills', icon: Lightbulb },
      { to: '/admin/automation', label: 'Jobs', icon: Jobs },
    ],
  },
  {
    label: 'Connectivity',
    items: [
      { to: '/admin/channels', label: 'Channels', icon: Channels },
      { to: '/admin/connectors', label: 'Connectors', icon: Plugins },
      { to: '/admin/mcp', label: 'MCP Servers', icon: Cog },
      {
        to: '/admin/federation',
        label: 'Agent2Agent',
        icon: Share,
      },
    ],
  },
  {
    label: 'Models',
    items: [{ to: '/admin/models', label: 'Providers', icon: Models }],
  },
  {
    label: 'Security',
    items: [
      {
        to: '/admin/network-policy',
        label: 'Network Policy',
        icon: Network,
      },
      { to: '/admin/output-guard', label: 'Output Guard', icon: Policy },
      { to: '/admin/credentials', label: 'Credentials', icon: Secrets },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/gateway', label: 'Gateway', icon: Gateway },
      { to: '/admin/config', label: 'Settings', icon: Config },
      { to: '/admin/logs', label: 'Logs', icon: Logs },
      {
        to: '/admin/extensions',
        label: 'Plugins & Tools',
        icon: Plugins,
      },
      { to: '/admin/terminal', label: 'Terminal', icon: Terminal },
    ],
  },
  {
    label: 'Labs',
    defaultCollapsed: true,
    items: [
      {
        to: '/admin/harness-evolution',
        label: 'Harness Evolution',
        icon: Harness,
      },
      { to: '/admin/distill', label: 'Distill', icon: Flask },
    ],
  },
];
