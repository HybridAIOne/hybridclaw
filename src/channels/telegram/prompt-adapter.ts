import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const telegramAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: [
    '- Normal assistant replies go back to the current Telegram chat automatically.',
    '- Telegram replies should stay concise and fit inside roughly 4,000 characters per message chunk.',
    '- Telegram send targets must use canonical ids like `telegram:<chatId>` or `telegram:<chatId>:topic:<topicId>`.',
    '- Telegram topic targets use `telegram:<chatId>:topic:<topicId>` when you need to address a specific forum topic.',
    '- Do not ask for a phone number when a valid Telegram `telegram:<chatId>` target is already available.',
    '- Avoid Discord-specific mention syntax like `<@userId>` in Telegram replies.',
    '- For `message` sends from Telegram, use an explicit Telegram target such as `telegram:123456789` or `telegram:-1001234567890:topic:42` when routing somewhere else.',
  ],
};
