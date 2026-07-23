export const ACTIVITY_TABS = [
  { id: 'usage', label: 'Usage' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'audit', label: 'Audit log' },
] as const;

export const AGENT_TABS = [
  { id: 'scoreboard', label: 'Scoreboard' },
  { id: 'files', label: 'Workspace files' },
] as const;

export const AUTOMATION_TABS = [
  {
    id: 'work-queue',
    label: 'Work queue',
    aliases: ['job board', 'jobs board'],
  },
  { id: 'schedules', label: 'Schedules' },
] as const;

export const CREDENTIAL_TABS = [
  { id: 'secrets', label: 'Secrets' },
  { id: 'api-tokens', label: 'API tokens' },
] as const;

export const EXTENSION_TABS = [
  { id: 'plugins', label: 'Plugins' },
  { id: 'tools', label: 'Tool catalog' },
] as const;

export const FEDERATION_TABS = [
  { id: 'peers', label: 'Peers & trust' },
  { id: 'topology', label: 'Fleet topology' },
  { id: 'inbox', label: 'A2A inbox' },
] as const;

export const ADMIN_TAB_GROUPS = [
  { label: 'Activity', to: '/admin/activity', tabs: ACTIVITY_TABS },
  { label: 'Agents', to: '/admin/agents', tabs: AGENT_TABS },
  { label: 'Jobs', to: '/admin/automation', tabs: AUTOMATION_TABS },
  {
    label: 'Agent2Agent',
    to: '/admin/federation',
    tabs: FEDERATION_TABS,
  },
  {
    label: 'Credentials',
    to: '/admin/credentials',
    tabs: CREDENTIAL_TABS,
  },
  {
    label: 'Plugins & Tools',
    to: '/admin/extensions',
    tabs: EXTENSION_TABS,
  },
] as const;
