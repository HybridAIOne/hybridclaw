export type ChannelKind =
  | 'discord'
  | 'email'
  | 'heartbeat'
  | 'msteams'
  | 'scheduler'
  | 'tui'
  | 'whatsapp';

export type SkillConfigChannelKind = Extract<
  ChannelKind,
  'discord' | 'email' | 'msteams' | 'whatsapp'
>;

export interface ChannelCapabilities {
  typing: boolean;
  reactions: boolean;
  threads: boolean;
  embeds: boolean;
  attachments: boolean;
  messageEditing: boolean;
  maxMessageLength: number;
}

export interface ChannelInfo {
  kind: ChannelKind;
  id: string;
  capabilities: ChannelCapabilities;
}

export const SYSTEM_CAPABILITIES: ChannelCapabilities = Object.freeze({
  typing: false,
  reactions: false,
  threads: false,
  embeds: false,
  attachments: false,
  messageEditing: false,
  maxMessageLength: 0,
});

export const DISCORD_CAPABILITIES: ChannelCapabilities = Object.freeze({
  typing: true,
  reactions: true,
  threads: true,
  embeds: true,
  attachments: true,
  messageEditing: true,
  maxMessageLength: 2_000,
});

export const TUI_CAPABILITIES: ChannelCapabilities = SYSTEM_CAPABILITIES;

export const WHATSAPP_CAPABILITIES: ChannelCapabilities = Object.freeze({
  typing: true,
  reactions: true,
  threads: false,
  embeds: false,
  attachments: true,
  messageEditing: false,
  maxMessageLength: 65_536,
});

export const EMAIL_CAPABILITIES: ChannelCapabilities = Object.freeze({
  ...SYSTEM_CAPABILITIES,
  attachments: true,
});

export const MSTEAMS_CAPABILITIES: ChannelCapabilities = Object.freeze({
  typing: true,
  reactions: true,
  threads: true,
  embeds: true,
  attachments: true,
  messageEditing: true,
  maxMessageLength: 28_000,
});
