/**
 * Registered message backends define advertising, not channel authorization.
 * Independent skill services do not belong to this transport inventory.
 */
import {
  formatMessageToolChannelList,
  MESSAGE_TOOL_CHANNEL_KINDS,
  type MessageToolChannelKind,
  normalizeMessageToolChannelKinds,
  shouldOfferMessageTool,
} from '@hybridclaw/shared/message-tool-channels';
import { listChannels } from './channel-registry.js';

export type { MessageToolChannelKind };
export {
  formatMessageToolChannelList,
  MESSAGE_TOOL_CHANNEL_KINDS,
  normalizeMessageToolChannelKinds,
  shouldOfferMessageTool,
};

// Email is described per agent by `describeEmailAction`.
const MESSAGE_TOOL_CHANNEL_ACTIONS: Record<
  Exclude<MessageToolChannelKind, 'email'>,
  string
> = {
  discord:
    'Discord: send/read messages, upload files, inspect members/channels, react, edit, pin, and manage threads.',
  discord_webhook:
    'Discord webhook: send outbound-only messages to configured Discord Incoming Webhook targets.',
  imessage: 'iMessage: send messages to explicit iMessage handles.',
  line: 'LINE: send messages to the linked account self-chat only.',
  msteams:
    'Microsoft Teams: send/read known Teams conversations, upload files, and inspect members/channels.',
  signal:
    'Signal: send messages to explicit Signal recipients (phone numbers, UUIDs, or `group:<id>`).',
  slack:
    'Slack: send/read known Slack conversations, upload files, and inspect members/channels.',
  slack_webhook:
    'Slack webhook: send outbound-only Block Kit messages to configured webhook targets.',
  telegram:
    'Telegram: send messages and uploads to explicit Telegram chat or topic targets.',
  threema:
    'Threema: send text messages to explicit Threema IDs, phone numbers, or email lookups.',
  tui: 'Local TUI: queue messages for local TUI delivery.',
  whatsapp:
    'WhatsApp: send messages and uploads to explicit WhatsApp JIDs or phone numbers.',
};

export function collectActiveMessageToolChannelKinds(): MessageToolChannelKind[] {
  return normalizeMessageToolChannelKinds(
    listChannels().map((channel) => channel.kind),
  );
}

// The model must know whose address its mail carries: an agent without a
// mailbox borrows the default one, and only setup can change that.
function describeEmailAction(ownEmailAddress: string | null): string {
  const userMail =
    "Mail in the user's name goes from their own connected mail account, not this one.";
  if (ownEmailAddress) {
    return `Email: send and read email in this agent's own mailbox, ${ownEmailAddress}. ${userMail}`;
  }
  return `Email: this agent has no mailbox of its own yet. Email it sends goes out from the shared default mailbox under this agent's name, and reading reads that mailbox. You cannot create a mailbox or change the sender address; an owner must give this agent a mailbox. ${userMail}`;
}

export function describeMessageToolChannelActions(
  kinds: readonly string[] | undefined,
  ownEmailAddress: string | null = null,
): string[] {
  return normalizeMessageToolChannelKinds(kinds).map(
    (kind) =>
      `- ${kind === 'email' ? describeEmailAction(ownEmailAddress) : MESSAGE_TOOL_CHANNEL_ACTIONS[kind]}`,
  );
}
