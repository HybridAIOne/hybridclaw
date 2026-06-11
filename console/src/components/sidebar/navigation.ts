import type { ComponentType } from 'react';
import {
  AgentGroup,
  Audit,
  Channels,
  Chat,
  Cog,
  Config,
  Dashboard,
  Email,
  Files,
  Gateway,
  Harness,
  Jobs,
  Models,
  Plugins,
  Policy,
  Scheduler,
  Secrets,
  Server,
  Sessions,
  Skills,
  SquarePen,
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
      { to: '/admin/a2a-inbox', label: 'A2A Inbox', icon: Chat },
      { to: '/admin/a2a-trust', label: 'A2A Trust', icon: Policy },
      { to: '/admin/audit', label: 'Audit', icon: Audit },
      { to: '/admin/jobs', label: 'Jobs', icon: Jobs },
      {
        to: '/admin/harness-evolution',
        label: 'Harness Evolution',
        icon: Harness,
      },
      { to: '/admin/distill', label: 'Distill', icon: Skills },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { to: '/admin/terminal', label: 'Terminal', icon: Terminal },
      { to: '/admin/gateway', label: 'Gateway', icon: Gateway },
      { to: '/admin/fleet-topology', label: 'Fleet', icon: Server },
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
      { to: '/admin/output-guard', label: 'Output Guard', icon: SquarePen },
      { to: '/admin/tools', label: 'Tools', icon: Tools },
      { to: '/admin/secrets', label: 'Secrets', icon: Secrets },
      { to: '/admin/config', label: 'Config', icon: Config },
    ],
  },
];
