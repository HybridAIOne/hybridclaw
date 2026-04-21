import {
  formatMessageToolChannelList,
  MESSAGE_TOOL_CHANNEL_KINDS,
  type MessageToolChannelKind,
  normalizeMessageToolChannelKinds,
} from '../../container/shared/message-tool-channels.js';
import { listChannels } from './channel-registry.js';

export type { MessageToolChannelKind };
export {
  formatMessageToolChannelList,
  MESSAGE_TOOL_CHANNEL_KINDS,
  normalizeMessageToolChannelKinds,
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

export function collectActiveMessageToolChannelKinds(): MessageToolChannelKind[] {
  return normalizeMessageToolChannelKinds(
    listChannels().map((channel) => channel.kind),
  );
}

export function describeMessageToolChannelActions(
  kinds: readonly string[] | undefined,
): string[] {
  return normalizeMessageToolChannelKinds(kinds).map(
    (kind) => `- ${MESSAGE_TOOL_CHANNEL_ACTIONS[kind]}`,
  );
}
