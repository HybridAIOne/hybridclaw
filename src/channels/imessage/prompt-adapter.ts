import { normalizeTrimmedString as trimValue } from '../../utils/normalized-strings.js';
import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';
import { isIMessageGroupHandle, parseIMessageChannelId } from './handle.js';

export const imessageAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);
    const target = parseIMessageChannelId(channelId);
    const isGroup = target ? isIMessageGroupHandle(target) : false;

    const hints = [
      '- Current channel is iMessage. Keep replies concise, plain-text friendly, and free of Discord-specific syntax.',
      '- Outbound iMessage text is chunked around 4,000 characters; prefer short paragraphs and compact lists.',
      '- iMessage does not support Discord-style mentions, embeds, or interactive components.',
      '- For cross-channel `message` sends from here, use explicit non-iMessage targets such as Discord ids/#channel, WhatsApp JIDs/phone numbers, or email addresses.',
    ];

    if (channelId) {
      hints.unshift(
        `- Current iMessage chat: \`${channelId}\`. Normal assistant replies go back here automatically.`,
      );
    }
    hints.push(
      isGroup
        ? '- Current iMessage context is a group chat.'
        : '- Current iMessage context is a direct chat.',
    );

    return hints;
  },
};
