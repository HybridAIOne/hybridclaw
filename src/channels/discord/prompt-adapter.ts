import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

export const discordAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);
    const guildId = trimValue(runtimeInfo?.guildId);

    const hints: string[] = [
      '- Discord targets: use `channelId` (aliases: `to`, `target`) with a snowflake ID, `<#channelId>`, or `#channel-name` (prefer adding `guildId` for `#channel-name` lookup).',
      '- Supported actions: `read` (channel history), `member-info` (user lookup), `channel-info` (channel metadata), and `send` (post/DM).',
      '- For DMs from names/mentions, call `member-info` first to resolve the user, then call `send` with the resolved target plus `content`.',
      '- Mentions are supported in `content` using raw Discord markup (for example `<@userId>` and `<#channelId>`).',
    ];

    if (channelId) {
      hints.unshift(
        `- Current Discord channel: \`${channelId}\`. Omit \`channelId\`/\`to\` to target this channel for \`read\`, \`channel-info\`, and \`send\`.`,
      );
    }
    if (runtimeInfo?.guildId === null) {
      hints.push('- Current Discord context is a DM (no guildId available).');
    } else if (guildId) {
      hints.push(
        `- Current Discord guild: \`${guildId}\`. Include \`guildId\` when resolving \`#channel-name\` or members by name.`,
      );
    }

    return hints;
  },
};
