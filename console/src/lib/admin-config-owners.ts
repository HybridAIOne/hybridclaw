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
  scheduler: { label: 'Automation', to: '/admin/automation' },
};
