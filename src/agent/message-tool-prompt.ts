/**
 * Message prompt guidance advertises only the registered channel snapshot.
 * This does not describe independent skill services or grant channel access;
 * unlike the tool schema, it carries workflow examples for ready backends.
 */
import {
  describeMessageToolChannelActions,
  formatMessageToolChannelList,
  type MessageToolChannelKind,
  shouldOfferMessageTool,
} from '../channels/message-tool-advertising.js';
import { SILENT_REPLY_TOKEN } from './silent-reply.js';

export function buildMessageToolPromptLines(
  activeChannels: readonly MessageToolChannelKind[],
  channelMessageToolHints: readonly string[],
): string[] {
  if (!shouldOfferMessageTool(activeChannels)) {
    return [
      'The built-in `message` tool is unavailable: no active communication channel backend is registered.',
    ];
  }
  const lines = [
    `Use the \`message\` tool for sending or reading messages on active communication channels: ${formatMessageToolChannelList(activeChannels)}.`,
    'Do not use `message` for ordinary final replies in the current chat. Use the assistant final response instead, including when returning web chat artifacts. Only call `message` when the user asks to send/read/post on a communication channel.',
  ];

  const channelActionLines = describeMessageToolChannelActions(activeChannels);
  if (channelActionLines.length > 0) {
    lines.push(...channelActionLines);
    lines.push(
      'For `message` sends, include target as `channelId` (aliases: `to`, `target`) and text as `content` (aliases: `message`, `text`).',
      `If \`message\` with \`action="send"\` already delivered the final user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
    );
  }

  if (channelMessageToolHints.length > 0) {
    lines.push(
      '',
      '### Message Tool Hints',
      '- The current chat is the **Chat ID** in the latest `<context>` message, and its server, team, or workspace is the **Guild** there.',
      ...channelMessageToolHints,
    );
  }

  const examples: string[] = [];
  if (activeChannels.includes('discord')) {
    examples.push(
      'Example: "What did Bob say in #general?" -> `message` {"action":"read","channelId":"<discord-channel-id>","limit":50}',
      'Example: "Send a message to #general saying hello" -> `message` {"action":"send","channelId":"<discord-channel-id>","content":"hello"}',
    );
  }
  if (activeChannels.includes('msteams')) {
    examples.push(
      'Example: "Post this file in the current Teams chat" -> `message` {"action":"send","filePath":"path/in/workspace"}',
    );
  }
  if (activeChannels.includes('slack')) {
    examples.push(
      'Example: "Read the current Slack thread" -> `message` {"action":"read","channelId":"slack:current","limit":50}',
    );
  }
  if (activeChannels.includes('telegram')) {
    examples.push(
      'Example: "Send this to Telegram" -> `message` {"action":"send","to":"telegram:<chatId>","content":"message text"}',
    );
  }
  if (activeChannels.includes('signal')) {
    examples.push(
      'Example: "Send this on Signal" -> `message` {"action":"send","to":"signal:+15551234567","content":"message text"}',
    );
  }
  if (activeChannels.includes('threema')) {
    examples.push(
      'Example: "Send this on Threema" -> `message` {"action":"send","to":"threema:ABCDEFGH","content":"message text"}',
    );
  }
  if (activeChannels.includes('whatsapp')) {
    examples.push(
      'Example: "Send this to WhatsApp" -> `message` {"action":"send","to":"whatsapp:<phone-or-jid>","content":"message text"}',
    );
  }
  if (activeChannels.includes('line')) {
    examples.push(
      'Example: "Send this to my LINE self-chat" -> `message` {"action":"send","to":"line:<linked-user-mid>","content":"message text"}',
    );
  }
  if (activeChannels.includes('email')) {
    examples.push(
      'Example: "Email ops@example.com that the deployment is complete" -> `message` {"action":"send","to":"ops@example.com","content":"[Subject: Deployment complete]\\n\\nDeployment is complete."}',
    );
  }
  if (activeChannels.includes('imessage')) {
    examples.push(
      'Example: "Send this by iMessage" -> `message` {"action":"send","to":"+15551234567","content":"message text"}',
    );
  }
  if (activeChannels.includes('tui')) {
    examples.push(
      'Example: "Post this to the local TUI" -> `message` {"action":"send","to":"tui","content":"message text"}',
    );
  }
  if (examples.length > 0) {
    lines.push('', '### Message Tool Examples', ...examples);
  }

  return lines;
}
