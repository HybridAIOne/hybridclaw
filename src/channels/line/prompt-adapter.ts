import { normalizeTrimmedString as trimValue } from '../../utils/normalized-strings.js';
import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';
import { parseLineTarget } from './target.js';

export const lineAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);
    const target = channelId ? parseLineTarget(channelId) : null;
    const hints = [
      '- LINE replies should stay concise and fit inside 5,000-character text message chunks.',
      '- LINE send targets must use canonical ids like `line:<userId>`, `line:group:<groupId>`, or `line:room:<roomId>`.',
      '- LINE Basic mode supports outbound text only; do not attach local files or assume media delivery unless a public HTTPS URL workflow is explicitly available.',
      '- LINE IDs are case-sensitive; preserve the casing from the webhook or configured target.',
      '- Avoid Discord-specific mention syntax like `<@userId>` in LINE replies.',
    ];

    if (channelId) {
      hints.unshift(
        `- Current LINE chat: \`${channelId}\`. Normal assistant replies go back here automatically.`,
      );
    }

    if (target?.kind === 'group' || target?.kind === 'room') {
      hints.push('- Current LINE context is a group or room chat.');
    } else if (target?.kind === 'user') {
      hints.push('- Current LINE context is a direct chat.');
    }

    return hints;
  },
};
