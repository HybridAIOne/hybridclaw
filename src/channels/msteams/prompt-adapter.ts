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
      '- In Teams, the `message` tool can send into the current Teams conversation, including a local `filePath` upload. Omit `channelId` to target this chat.',
      '- If you already created a file earlier in this session and the user asks to post or upload it here, call `message` with `action="send"` and that existing `filePath`. Do not reply with the file path alone.',
      '- Teams-specific `message` support is send-only for the current conversation; Discord history/member lookup actions still require Discord targets.',
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
