import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const discordWebhookAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: [
    '- Discord webhook targets use `discord_webhook` for the default webhook or `discord_webhook:<target>` for a named webhook.',
    '- Discord webhook sends are outbound-only. Do not read Discord history, react, edit messages, upload files, use components, or assume threads are available.',
    '- Discord webhook text is delivered as plain Discord message content with mentions disabled.',
    '- Keep each logical message concise; long text is split across multiple Discord webhook posts.',
  ],
};
