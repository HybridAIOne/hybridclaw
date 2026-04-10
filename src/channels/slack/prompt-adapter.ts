import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

export const slackAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);
    const workspaceId = trimValue(runtimeInfo?.guildId);

    const hints: string[] = [
      '- Current channel is Slack. Keep replies concise, readable in plain mrkdwn, and avoid assuming rich formatting beyond links, lists, and code fences.',
      '- Slack replies in channels usually belong in a thread. Keep the first line informative because thread previews are often all the user sees.',
      '- In Slack, the `message` tool supports `read`, `channel-info`, `member-info`, and `send` for the current active Slack session.',
      '- Omit `channelId` to target the current Slack conversation. For current-session lookups you can also use `slack:current`.',
      '- Slack `member-info` resolves known participants from the current Slack session history, not a workspace-wide directory search.',
      '- If you already created a file earlier in this session and the user asks to post it here, call `message` with `action="send"` and that existing `filePath` instead of replying with the path alone.',
    ];

    if (channelId) {
      hints.unshift(`- Current Slack conversation: \`${channelId}\`.`);
    }
    if (workspaceId) {
      hints.push(`- Current Slack workspace/team id: \`${workspaceId}\`.`);
    } else {
      hints.push('- Current Slack context is a direct message.');
    }

    return hints;
  },
};
