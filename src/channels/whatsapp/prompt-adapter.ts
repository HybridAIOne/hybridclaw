import { normalizeTrimmedString as trimValue } from '../../utils/normalized-strings.js';
import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';
import { isGroupJid } from './phone.js';

export const whatsappAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);
    const isGroup = channelId ? isGroupJid(channelId) : false;

    const hints = [
      '- WhatsApp formatting uses `*bold*`, `_italic_`, `~strike~`, and triple-backtick code fences.',
      '- Keep each WhatsApp message chunk concise and under roughly 4,000 characters.',
      '- Avoid Discord-specific syntax like `<@userId>` or `<#channelId>` in WhatsApp replies.',
      '- For `message` sends from WhatsApp, always provide an explicit target when sending to another channel. Use Discord ids/#channel for Discord, a WhatsApp JID/phone number for WhatsApp, or an email address for email.',
    ];

    if (channelId) {
      hints.unshift(
        `- Current WhatsApp chat: \`${channelId}\`. Normal assistant replies go back here automatically; do not reuse this WhatsApp JID as a Discord target.`,
      );
    }
    hints.push(
      isGroup
        ? '- Current WhatsApp context is a group chat.'
        : '- Current WhatsApp context is a direct chat.',
    );

    return hints;
  },
};
