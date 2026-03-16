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
      '- In Teams, the `message` tool supports `read`, `channel-info`, `member-info`, and `send` for the current chat and other known Teams conversations.',
      '- Omit `channelId` to target the current Teams chat. Use a known Teams conversation ID or Teams session ID to target another Teams conversation the gateway has already seen.',
      '- Teams `member-info` is based on the current peer or known transcript participants, not a tenant-wide directory lookup.',
      '- If you already created a file earlier in this session and the user asks to post or upload it here, call `message` with `action="send"` and that existing `filePath`. Do not reply with the file path alone.',
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
