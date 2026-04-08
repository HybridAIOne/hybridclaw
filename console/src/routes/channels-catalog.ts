import type { AdminConfig } from '../api/types';

export type ChannelKind =
  | 'discord'
  | 'whatsapp'
  | 'email'
  | 'msteams'
  | 'imessage';

export interface ChannelCatalogItem {
  kind: ChannelKind;
  label: string;
  summary: string;
  statusTone: 'active' | 'configured' | 'available';
  statusLabel: string;
}

interface ChannelCatalogOptions {
  whatsappLinked?: boolean;
  emailPasswordConfigured?: boolean;
  imessagePasswordConfigured?: boolean;
}

function countKeys(value: Record<string, unknown>): number {
  return Object.keys(value).length;
}

export function countDiscordGuilds(config: AdminConfig): number {
  return countKeys(config.discord.guilds);
}

export function countDiscordOverrides(config: AdminConfig): number {
  return Object.values(config.discord.guilds).reduce((total, guild) => {
    return total + countKeys(guild.channels);
  }, 0);
}

export function countTeams(config: AdminConfig): number {
  return countKeys(config.msteams.teams);
}

export function countTeamsOverrides(config: AdminConfig): number {
  return Object.values(config.msteams.teams).reduce((total, team) => {
    return total + countKeys(team.channels);
  }, 0);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function describeDiscord(config: AdminConfig): ChannelCatalogItem {
  const guildCount = countDiscordGuilds(config);
  const overrideCount = countDiscordOverrides(config);
  const enabled = config.discord.groupPolicy !== 'disabled';
  const configured = guildCount > 0 || overrideCount > 0;
  const statusTone = enabled
    ? 'active'
    : configured
      ? 'configured'
      : 'available';

  return {
    kind: 'discord',
    label: 'Discord',
    summary: `${pluralize(guildCount, 'guild default')} · ${pluralize(overrideCount, 'explicit override')}`,
    statusTone,
    statusLabel:
      statusTone === 'active'
        ? 'active'
        : statusTone === 'configured'
          ? 'configured'
          : 'available',
  };
}

function describeWhatsApp(
  config: AdminConfig,
  options: ChannelCatalogOptions,
): ChannelCatalogItem {
  const linked = options.whatsappLinked === true;
  const enabled =
    config.whatsapp.dmPolicy !== 'disabled' ||
    config.whatsapp.groupPolicy !== 'disabled';
  const summary = linked
    ? enabled
      ? `Linked device · groups ${config.whatsapp.groupPolicy}`
      : 'Linked device available but transport is off'
    : enabled
      ? 'Link device to enable WhatsApp'
      : 'WhatsApp transport is off';
  const statusTone = linked ? (enabled ? 'active' : 'configured') : 'available';

  return {
    kind: 'whatsapp',
    label: 'WhatsApp',
    summary,
    statusTone,
    statusLabel:
      statusTone === 'active'
        ? 'active'
        : statusTone === 'configured'
          ? 'configured'
          : 'available',
  };
}

function describeEmail(
  config: AdminConfig,
  options: ChannelCatalogOptions,
): ChannelCatalogItem {
  const passwordConfigured = options.emailPasswordConfigured === true;
  const active =
    config.email.enabled &&
    passwordConfigured &&
    !!config.email.address &&
    !!config.email.imapHost &&
    !!config.email.smtpHost;
  const configured =
    active ||
    !!config.email.address ||
    !!config.email.imapHost ||
    !!config.email.smtpHost ||
    config.email.allowFrom.length > 0;
  const statusTone = active
    ? 'active'
    : configured
      ? 'configured'
      : 'available';

  return {
    kind: 'email',
    label: 'Email',
    summary: config.email.address || 'No mailbox address configured yet',
    statusTone,
    statusLabel:
      statusTone === 'active'
        ? 'active'
        : statusTone === 'configured'
          ? 'configured'
          : 'available',
  };
}

function describeMSTeams(config: AdminConfig): ChannelCatalogItem {
  const teamCount = countTeams(config);
  const overrideCount = countTeamsOverrides(config);
  const active =
    config.msteams.enabled &&
    !!config.msteams.appId &&
    !!config.msteams.tenantId;
  const configured =
    active ||
    config.msteams.enabled ||
    !!config.msteams.appId ||
    !!config.msteams.tenantId ||
    teamCount > 0 ||
    overrideCount > 0;
  const statusTone = active
    ? 'active'
    : configured
      ? 'configured'
      : 'available';

  return {
    kind: 'msteams',
    label: 'Microsoft Teams',
    summary: `${pluralize(teamCount, 'team default')} · ${pluralize(overrideCount, 'channel override')}`,
    statusTone,
    statusLabel:
      statusTone === 'active'
        ? 'active'
        : statusTone === 'configured'
          ? 'configured'
          : 'available',
  };
}

function describeIMessage(
  config: AdminConfig,
  options: ChannelCatalogOptions,
): ChannelCatalogItem {
  const isRemote = config.imessage.backend === 'bluebubbles';
  const passwordConfigured = options.imessagePasswordConfigured === true;
  const active = isRemote
    ? config.imessage.enabled &&
      passwordConfigured &&
      !!config.imessage.serverUrl &&
      !!config.imessage.webhookPath
    : config.imessage.enabled &&
      !!config.imessage.cliPath &&
      !!config.imessage.dbPath;
  const statusTone = active ? 'active' : 'available';

  return {
    kind: 'imessage',
    label: 'iMessage',
    summary: `${isRemote ? 'Remote' : 'Local'} backend · DM ${config.imessage.dmPolicy}`,
    statusTone,
    statusLabel: statusTone === 'active' ? 'active' : 'available',
  };
}

function scoreStatus(item: ChannelCatalogItem): number {
  switch (item.statusTone) {
    case 'active':
      return 2;
    case 'configured':
      return 1;
    default:
      return 0;
  }
}

export function buildChannelCatalog(
  config: AdminConfig,
  options: ChannelCatalogOptions = {},
): ChannelCatalogItem[] {
  return [
    describeDiscord(config),
    describeWhatsApp(config, options),
    describeEmail(config, options),
    describeMSTeams(config),
    describeIMessage(config, options),
  ].sort((left, right) => {
    const scoreDelta = scoreStatus(right) - scoreStatus(left);
    return scoreDelta !== 0
      ? scoreDelta
      : left.label.localeCompare(right.label);
  });
}
