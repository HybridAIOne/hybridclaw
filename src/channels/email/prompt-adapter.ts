import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

export const emailAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);

    const hints = [
      '- Email replies should stay plain-text, readable, and free of Discord-specific syntax.',
      '- For a new outbound email thread, start the message body with `[Subject: Your subject here]` on its own line.',
      '- For replies in the current email thread, omit the subject prefix; the runtime keeps `Re:` subject continuity and threading headers automatically.',
      '- Email `message` sends use a plain email address like `user@example.com` as the target.',
      '- Keep each outbound email chunk under roughly 50,000 characters.',
    ];

    if (channelId) {
      hints.unshift(
        `- Current email peer: \`${channelId}\`. Normal assistant replies go back here automatically.`,
      );
    }

    return hints;
  },
};
