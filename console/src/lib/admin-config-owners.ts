import { CHANNEL_CONFIG_SECTIONS, channelFragment } from './channels';

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
  ...Object.fromEntries(
    Object.entries(CHANNEL_CONFIG_SECTIONS).map(([kind, section]) => [
      section,
      adminChannelOwner(channelFragment(kind)),
    ]),
  ),
  mcpServers: { label: 'MCP Servers', to: '/admin/mcp' },
  outputGuard: { label: 'Output Guard', to: '/admin/output-guard' },
  scheduler: { label: 'Jobs', to: '/admin/automation?tab=schedules' },
};
