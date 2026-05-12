import { normalizeTrimmedString as trimValue } from '../../utils/normalized-strings.js';
import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const threemaAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);
    const hints = [
      '- Threema replies should stay concise and plain text; avoid markdown-heavy formatting.',
      '- Threema send targets must use canonical ids like `threema:ABCDEFGH`, `threema:phone:41791234567`, or `threema:email:user@example.com`.',
      '- Threema Basic mode supports outbound text only; do not attach files or assume inbound chat history is available.',
      '- Avoid Discord-specific mention syntax like `<@userId>` in Threema messages.',
    ];

    if (channelId) {
      hints.unshift(
        `- Current Threema chat: \`${channelId}\`. Normal assistant replies go back here automatically when the channel supports inbound.`,
      );
    }

    return hints;
  },
};
