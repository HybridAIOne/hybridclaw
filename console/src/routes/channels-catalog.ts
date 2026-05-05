import type { AdminConfig } from '../api/types';
import { pluralize } from '../lib/format';

export type ChannelKind =
  | 'discord'
  | 'slack'
  | 'signal'
  | 'telegram'
  | 'voice'
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
  discordTokenConfigured?: boolean;
  slackBotTokenConfigured?: boolean;
  slackAppTokenConfigured?: boolean;
  signalDaemonUrlConfigured?: boolean;
  signalAccountConfigured?: boolean;
  signalCliAvailable?: boolean;
  telegramTokenConfigured?: boolean;
  voiceAuthTokenConfigured?: boolean;
  whatsappLinked?: boolean;
  emailPasswordConfigured?: boolean;
  imessagePasswordConfigured?: boolean;
}

function countKeys(value: Record<string, unknown>): number {
  return Object.keys(value).length;
}

export function countDiscordGuilds(config: AdminConfig): number {
  return countKeys(config.discord?.guilds ?? {});
}

export function countDiscordOverrides(config: AdminConfig): number {
  return Object.values(config.discord?.guilds ?? {}).reduce((total, guild) => {
    return total + countKeys(guild.channels);
  }, 0);
}

export function countTeams(config: AdminConfig): number {
  return countKeys(config.msteams?.teams ?? {});
}

export function countTeamsOverrides(config: AdminConfig): number {
  return Object.values(config.msteams?.teams ?? {}).reduce((total, team) => {
    return total + countKeys(team.channels);
  }, 0);
}

function describeDiscord(
  config: AdminConfig,
  options: ChannelCatalogOptions,
): ChannelCatalogItem {
  const guildCount = countDiscordGuilds(config);
  const overrideCount = countDiscordOverrides(config);
  const enabled = config.discord
    ? config.discord.commandsOnly || config.discord.groupPolicy !== 'disabled'
    : false;
  const tokenConfigured = options.discordTokenConfigured === true;
  const active = enabled && tokenConfigured;
  const configured =
    active || tokenConfigured || guildCount > 0 || overrideCount > 0;
  const statusTone = active
    ? 'active'
    : configured
      ? 'configured'
      : 'available';

  return {
    kind: 'discord',
    label: 'Discord',
    summary: config.discord
      ? `${pluralize(guildCount, 'guild default')} · ${pluralize(overrideCount, 'explicit override')}`
      : 'Not configured',
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
  const enabled = config.whatsapp
    ? config.whatsapp.dmPolicy !== 'disabled' ||
      config.whatsapp.groupPolicy !== 'disabled'
    : false;
  const summary = linked
    ? enabled
      ? `Linked device · groups ${config.whatsapp?.groupPolicy}`
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

function describeTelegram(
  config: AdminConfig,
  options: ChannelCatalogOptions,
): ChannelCatalogItem {
  const tokenConfigured = options.telegramTokenConfigured === true;
  const inboundEnabled =
    config.telegram?.dmPolicy !== 'disabled' ||
    config.telegram?.groupPolicy !== 'disabled';
  const active =
    (config.telegram?.enabled ?? false) && tokenConfigured && inboundEnabled;
  const configured =
    active ||
    (config.telegram?.enabled ?? false) ||
    tokenConfigured ||
    (config.telegram?.allowFrom?.length ?? 0) > 0 ||
    (config.telegram?.groupAllowFrom?.length ?? 0) > 0;
  const statusTone = active
    ? 'active'
    : configured
      ? 'configured'
      : 'available';

  return {
    kind: 'telegram',
    label: 'Telegram',
    summary: config.telegram
      ? `DM ${config.telegram.dmPolicy} · groups ${config.telegram.groupPolicy}`
      : 'Not configured',
    statusTone,
    statusLabel:
      statusTone === 'active'
        ? 'active'
        : statusTone === 'configured'
          ? 'configured'
          : 'available',
  };
}

function describeSignal(
  config: AdminConfig,
  options: ChannelCatalogOptions,
): ChannelCatalogItem {
  const daemonUrlConfigured = options.signalDaemonUrlConfigured === true;
  const accountConfigured = options.signalAccountConfigured === true;
  const cliAvailable = options.signalCliAvailable === true;
  const inboundEnabled =
    config.signal.dmPolicy !== 'disabled' ||
    config.signal.groupPolicy !== 'disabled';
  const active =
    config.signal.enabled &&
    daemonUrlConfigured &&
    accountConfigured &&
    inboundEnabled;
  const configured =
    active ||
    config.signal.enabled ||
    daemonUrlConfigured ||
    accountConfigured ||
    cliAvailable ||
    config.signal.allowFrom.length > 0 ||
    config.signal.groupAllowFrom.length > 0;
  const statusTone = active
    ? 'active'
    : configured
      ? 'configured'
      : 'available';

  return {
    kind: 'signal',
    label: 'Signal',
    summary: `DM ${config.signal.dmPolicy} · groups ${config.signal.groupPolicy}${cliAvailable ? ' · QR ready' : ''}`,
    statusTone,
    statusLabel:
      statusTone === 'active'
        ? 'active'
        : statusTone === 'configured'
          ? 'configured'
          : 'available',
  };
}

function describeSlack(
  config: AdminConfig,
  options: ChannelCatalogOptions,
): ChannelCatalogItem {
  const botTokenConfigured = options.slackBotTokenConfigured === true;
  const appTokenConfigured = options.slackAppTokenConfigured === true;
  const active =
    (config.slack?.enabled ?? false) &&
    botTokenConfigured &&
    appTokenConfigured;
  const configured =
    active ||
    (config.slack?.enabled ?? false) ||
    botTokenConfigured ||
    appTokenConfigured ||
    (config.slack?.allowFrom?.length ?? 0) > 0 ||
    (config.slack?.groupAllowFrom?.length ?? 0) > 0;
  const statusTone = active
    ? 'active'
    : configured
      ? 'configured'
      : 'available';

  return {
    kind: 'slack',
    label: 'Slack',
    summary: config.slack
      ? `DM ${config.slack.dmPolicy} · channels ${config.slack.groupPolicy}`
      : 'Not configured',
    statusTone,
    statusLabel:
      statusTone === 'active'
        ? 'active'
        : statusTone === 'configured'
          ? 'configured'
          : 'available',
  };
}

function describeVoice(
  config: AdminConfig,
  options: ChannelCatalogOptions,
): ChannelCatalogItem {
  const authTokenConfigured = options.voiceAuthTokenConfigured === true;
  const accountSid = config.voice.twilio.accountSid.trim();
  const fromNumber = config.voice.twilio.fromNumber.trim();
  const active =
    config.voice.enabled && !!accountSid && !!fromNumber && authTokenConfigured;
  const configured =
    active ||
    config.voice.enabled ||
    !!accountSid ||
    !!fromNumber ||
    authTokenConfigured;
  const statusTone = active
    ? 'active'
    : configured
      ? 'configured'
      : 'available';

  return {
    kind: 'voice',
    label: 'Voice',
    summary: `Twilio · webhook ${config.voice.webhookPath}`,
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
    (config.email?.enabled ?? false) &&
    passwordConfigured &&
    !!config.email?.address &&
    !!config.email?.imapHost &&
    !!config.email?.smtpHost;
  const configured =
    active ||
    !!config.email?.address ||
    !!config.email?.imapHost ||
    !!config.email?.smtpHost ||
    (config.email?.allowFrom?.length ?? 0) > 0;
  const statusTone = active
    ? 'active'
    : configured
      ? 'configured'
      : 'available';

  return {
    kind: 'email',
    label: 'Email',
    summary: config.email?.address || 'No mailbox address configured yet',
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
    (config.msteams?.enabled ?? false) &&
    !!config.msteams?.appId &&
    !!config.msteams?.tenantId;
  const configured =
    active ||
    (config.msteams?.enabled ?? false) ||
    !!config.msteams?.appId ||
    !!config.msteams?.tenantId ||
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
    summary: config.msteams
      ? `${pluralize(teamCount, 'team default')} · ${pluralize(overrideCount, 'channel override')}`
      : 'Not configured',
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
  const isRemote = config.imessage?.backend === 'bluebubbles';
  const passwordConfigured = options.imessagePasswordConfigured === true;
  const active = isRemote
    ? (config.imessage?.enabled ?? false) &&
      passwordConfigured &&
      !!config.imessage?.serverUrl &&
      !!config.imessage?.webhookPath
    : (config.imessage?.enabled ?? false) &&
      !!config.imessage?.cliPath &&
      !!config.imessage?.dbPath;
  const statusTone = active ? 'active' : 'available';

  return {
    kind: 'imessage',
    label: 'iMessage',
    summary: config.imessage
      ? `${isRemote ? 'Remote' : 'Local'} backend · DM ${config.imessage.dmPolicy}`
      : 'Not configured',
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
    describeDiscord(config, options),
    describeSlack(config, options),
    describeTelegram(config, options),
    describeSignal(config, options),
    describeVoice(config, options),
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
