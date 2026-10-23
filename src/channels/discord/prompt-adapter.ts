import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

export const discordAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: [
    '- Omit `channelId`/`to` to target the current Discord channel for `read`, `channel-info`, and `send`.',
    '- Discord targets: use `channelId` (aliases: `to`, `target`) with a snowflake ID, `<#channelId>`, or `#channel-name` (prefer adding `guildId` for `#channel-name` lookup). Cross-channel sends from here may use a WhatsApp JID/phone number or an email address instead.',
    '- Supported actions: `read` (channel history), `member-info` (user lookup), `channel-info` (channel metadata), and `send` (post/DM/cross-channel send).',
    '- For DMs from names/mentions, call `member-info` first to resolve the user, then call `send` with the resolved target plus `content`.',
    '- For local Discord, WhatsApp, or email uploads, include `filePath` in `send`; it may be workspace-relative or under `/discord-media-cache`.',
    '- Mentions are supported in `content` using raw Discord markup (for example `<@userId>` and `<#channelId>`).',
    '- Include the current guild id as `guildId` when resolving `#channel-name` or members by name. A DM has no guild.',
  ],
};
