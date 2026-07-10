import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const lineAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = String(runtimeInfo?.channelId || '').trim();
    return [
      ...(channelId
        ? [
            `- Current LINE self-chat: \`${channelId}\`. Normal assistant replies return here automatically.`,
          ]
        : []),
      '- LINE is configured for the linked account self-chat only; do not attempt to address other LINE users or groups.',
      '- Keep LINE replies concise and avoid platform-specific mention syntax.',
    ];
  },
};
