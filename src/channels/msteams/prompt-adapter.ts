import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

export const msteamsAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);
    const teamId = trimValue(runtimeInfo?.guildId);

    const hints: string[] = [
      '- Current channel is Microsoft Teams. Prefer concise lists, short paragraphs, and markdown that still reads cleanly if the client falls back to plain text.',
      '- Teams replies may render inside a thread. Keep the first line informative because it is often what users see in channel previews.',
      '- If the reply is a structured checklist, status board, or summary table, it may be rendered as an Adaptive Card by the Teams transport.',
      '- The `message` tool does not currently target Teams conversations; use it for Discord, WhatsApp, email, or local channels only.',
    ];

    if (channelId) {
      hints.unshift(`- Current Teams conversation: \`${channelId}\`.`);
    }
    if (teamId) {
      hints.push(`- Current Teams team: \`${teamId}\`.`);
    } else {
      hints.push('- Current Teams context is a direct message.');
    }

    return hints;
  },
};
