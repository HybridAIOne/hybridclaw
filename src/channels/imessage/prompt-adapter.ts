import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const imessageAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: [
    '- Normal assistant replies go back to the current iMessage chat automatically.',
    '- Current channel is iMessage. Keep replies concise, plain-text friendly, and free of Discord-specific syntax.',
    '- Outbound iMessage text is chunked around 4,000 characters; prefer short paragraphs and compact lists.',
    '- iMessage does not support Discord-style mentions, embeds, or interactive components.',
    '- For cross-channel `message` sends from here, use explicit non-iMessage targets such as Discord ids/#channel, WhatsApp JIDs/phone numbers, or email addresses.',
  ],
};
