import { normalizeTrimmedString as trimValue } from '../../utils/normalized-strings.js';
import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';
import { resolveSignalTargetChatType } from './target.js';

export const signalAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);
    const chatType = resolveSignalTargetChatType(channelId);
    const hints = [
      '- Signal replies should stay concise and avoid markdown — Signal renders plain text only.',
      '- Signal send targets must use canonical ids like `signal:+15551234567`, `signal:<uuid>`, or `signal:group:<groupId>`.',
      '- For `message` sends from Signal, use an explicit Signal target such as `signal:+15551234567` when routing somewhere else.',
      '- Avoid Discord-specific mention syntax like `<@userId>` in Signal replies.',
    ];

    if (channelId) {
      hints.unshift(
        `- Current Signal chat: \`${channelId}\`. Normal assistant replies go back here automatically.`,
      );
    }

    if (chatType === 'group') {
      hints.push('- Current Signal context is a group chat.');
    } else if (chatType === 'direct') {
      hints.push('- Current Signal context is a direct chat.');
    }

    return hints;
  },
};
