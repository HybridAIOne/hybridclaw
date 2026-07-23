export type AdminConfigSectionOwner = {
  label: string;
  to: string;
};

const CHANNELS_OWNER: AdminConfigSectionOwner = {
  label: 'Channels',
  to: '/admin/channels',
};

export function adminChannelOwner(fragment: string): AdminConfigSectionOwner {
  return {
    label: 'Channels',
    to: `/admin/channels#${fragment}`,
  };
}

export const ADMIN_CONFIG_SECTION_OWNERS: Readonly<
  Partial<Record<string, AdminConfigSectionOwner>>
> = {
  channels: CHANNELS_OWNER,
  channelInstructions: CHANNELS_OWNER,
  discord: adminChannelOwner('discord'),
  discordWebhook: adminChannelOwner('discord_webhook'),
  email: adminChannelOwner('email'),
  imessage: adminChannelOwner('imessage'),
  line: adminChannelOwner('line'),
  msteams: adminChannelOwner('teams'),
  signal: adminChannelOwner('signal'),
  slack: adminChannelOwner('slack'),
  slackWebhook: adminChannelOwner('slack_webhook'),
  telegram: adminChannelOwner('telegram'),
  threema: adminChannelOwner('threema'),
  voice: adminChannelOwner('voice'),
  whatsapp: adminChannelOwner('whatsapp'),
  mcpServers: { label: 'MCP Servers', to: '/admin/mcp' },
  outputGuard: { label: 'Output Guard', to: '/admin/output-guard' },
  scheduler: { label: 'Jobs', to: '/admin/automation?tab=schedules' },
};
