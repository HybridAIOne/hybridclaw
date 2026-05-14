import { normalizeTrimmedString as trimValue } from '../../utils/normalized-strings.js';
import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const discordWebhookAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);
    const hints = [
      '- Discord webhook targets use `discord_webhook` for the default webhook or `discord_webhook:<target>` for a named webhook.',
      '- Discord webhook sends are outbound-only. Do not read Discord history, react, edit messages, upload files, use components, or assume threads are available.',
      '- Discord webhook text is delivered as plain Discord message content with mentions disabled.',
      '- Keep each logical message concise; long text is split across multiple Discord webhook posts.',
    ];

    if (channelId) {
      hints.unshift(
        `- Current Discord webhook target: \`${channelId}\`. This channel only supports explicit outbound sends.`,
      );
    }

    return hints;
  },
};
