import type { ChannelKind } from './channel.js';
import { listChannels } from './channel-registry.js';

export const MESSAGE_TOOL_CHANNEL_KINDS = [
  'discord',
  'email',
  'imessage',
  'msteams',
  'slack',
  'telegram',
  'tui',
  'whatsapp',
] as const satisfies readonly ChannelKind[];

export type MessageToolChannelKind =
  (typeof MESSAGE_TOOL_CHANNEL_KINDS)[number];

const MESSAGE_TOOL_CHANNEL_KIND_SET = new Set<ChannelKind>(
  MESSAGE_TOOL_CHANNEL_KINDS,
);

const MESSAGE_TOOL_CHANNEL_LABELS: Record<MessageToolChannelKind, string> = {
  discord: 'Discord',
  email: 'email',
  imessage: 'iMessage',
  msteams: 'Microsoft Teams',
  slack: 'Slack',
  telegram: 'Telegram',
  tui: 'local TUI',
  whatsapp: 'WhatsApp',
};

const MESSAGE_TOOL_CHANNEL_ACTIONS: Record<MessageToolChannelKind, string> = {
  discord:
    'Discord: send/read messages, upload files, inspect members/channels, react, edit, pin, and manage threads.',
  email: 'Email: send email and read ingested email thread history.',
  imessage: 'iMessage: send messages to explicit iMessage handles.',
  msteams:
    'Microsoft Teams: send/read known Teams conversations, upload files, and inspect members/channels.',
  slack:
    'Slack: send/read known Slack conversations, upload files, and inspect members/channels.',
  telegram:
    'Telegram: send messages and uploads to explicit Telegram chat or topic targets.',
  tui: 'Local TUI: queue messages for local TUI delivery.',
  whatsapp:
    'WhatsApp: send messages and uploads to explicit WhatsApp JIDs or phone numbers.',
};

function isMessageToolChannelKind(
  kind: ChannelKind | string,
): kind is MessageToolChannelKind {
  return MESSAGE_TOOL_CHANNEL_KIND_SET.has(kind as ChannelKind);
}

export function normalizeMessageToolChannelKinds(
  kinds: readonly string[] | undefined,
): MessageToolChannelKind[] {
  if (!Array.isArray(kinds)) return [];
  const normalized = new Set<MessageToolChannelKind>();
  for (const kind of kinds) {
    const candidate = String(kind || '')
      .trim()
      .toLowerCase();
    if (isMessageToolChannelKind(candidate)) {
      normalized.add(candidate);
    }
  }
  return [...normalized].sort();
}

export function collectActiveMessageToolChannelKinds(): MessageToolChannelKind[] {
  return normalizeMessageToolChannelKinds(
    listChannels().map((channel) => channel.kind),
  );
}

export function formatMessageToolChannelList(
  kinds: readonly string[] | undefined,
): string {
  const labels = normalizeMessageToolChannelKinds(kinds).map(
    (kind) => MESSAGE_TOOL_CHANNEL_LABELS[kind],
  );
  if (labels.length === 0) return 'none';
  return labels.join(', ');
}

export function describeMessageToolChannelActions(
  kinds: readonly string[] | undefined,
): string[] {
  return normalizeMessageToolChannelKinds(kinds).map(
    (kind) => `- ${MESSAGE_TOOL_CHANNEL_ACTIONS[kind]}`,
  );
}
