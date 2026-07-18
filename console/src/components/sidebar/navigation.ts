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
  Flask,
  Gateway,
  Harness,
  Jobs,
  Lightbulb,
  Logs,
  Models,
  Plugins,
  Policy,
  Scheduler,
  Secrets,
  Server,
  Sessions,
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

export type AdminConfigSectionOwner = {
  label: string;
  to: string;
};

const CHANNELS_OWNER: AdminConfigSectionOwner = {
  label: 'Channels',
  to: '/admin/channels',
};

export const ADMIN_CONFIG_SECTION_OWNERS: Readonly<
  Partial<Record<string, AdminConfigSectionOwner>>
> = {
  channels: CHANNELS_OWNER,
  channelInstructions: CHANNELS_OWNER,
  discord: CHANNELS_OWNER,
  discordWebhook: CHANNELS_OWNER,
  email: CHANNELS_OWNER,
  imessage: CHANNELS_OWNER,
  line: CHANNELS_OWNER,
  msteams: CHANNELS_OWNER,
  signal: CHANNELS_OWNER,
  slack: CHANNELS_OWNER,
  slackWebhook: CHANNELS_OWNER,
  telegram: CHANNELS_OWNER,
  threema: CHANNELS_OWNER,
  voice: CHANNELS_OWNER,
  whatsapp: CHANNELS_OWNER,
  mcpServers: { label: 'MCP Servers', to: '/admin/mcp' },
  outputGuard: { label: 'Output Guard', to: '/admin/output-guard' },
  scheduler: { label: 'Schedules', to: '/admin/scheduler' },
};

export const SIDEBAR_NAV_GROUPS: ReadonlyArray<SidebarNavGroup> = [
  {
    label: 'Overview',
    items: [
      { to: '/admin', label: 'Dashboard', icon: Dashboard },
      { to: '/admin/statistics', label: 'Statistics', icon: Statistics },
      { to: '/admin/sessions', label: 'Sessions', icon: Sessions },
      { to: '/admin/audit', label: 'Audit Log', icon: Audit },
    ],
  },
  {
    label: 'Agents',
    items: [
      {
        to: '/admin/agent-scoreboard',
        label: 'Agent Scoreboard',
        icon: AgentGroup,
      },
      { to: '/admin/agents', label: 'Workspace Files', icon: Files },
      { to: '/admin/skills', label: 'Skills', icon: Lightbulb },
      { to: '/admin/jobs', label: 'Work Queue', icon: Jobs },
      { to: '/admin/scheduler', label: 'Schedules', icon: Scheduler },
    ],
  },
  {
    label: 'Connectivity',
    items: [
      { to: '/admin/channels', label: 'Channels', icon: Channels },
      {
        to: '/admin/email',
        label: 'Mailbox',
        icon: Email,
        requiresEmail: true,
      },
      { to: '/admin/connectors', label: 'Connectors', icon: Plugins },
      { to: '/admin/mcp', label: 'MCP Servers', icon: Cog },
      { to: '/admin/a2a-inbox', label: 'A2A Inbox', icon: Chat },
      { to: '/admin/a2a-trust', label: 'A2A Trust', icon: Policy },
      {
        to: '/admin/fleet-topology',
        label: 'Fleet Topology',
        icon: Server,
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
        icon: Policy,
      },
      { to: '/admin/output-guard', label: 'Output Guard', icon: Policy },
      { to: '/admin/secrets', label: 'Secrets', icon: Secrets },
      { to: '/admin/tokens', label: 'API Tokens', icon: Secrets },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/gateway', label: 'Gateway', icon: Gateway },
      { to: '/admin/config', label: 'Settings', icon: Config },
      { to: '/admin/logs', label: 'Logs', icon: Logs },
      { to: '/admin/plugins', label: 'Plugins', icon: Plugins },
      { to: '/admin/tools', label: 'Tools', icon: Tools },
      { to: '/admin/terminal', label: 'Terminal', icon: Terminal },
    ],
  },
  {
    label: 'Labs',
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
