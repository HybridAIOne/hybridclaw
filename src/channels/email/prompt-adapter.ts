import type { ChannelAgentPromptAdapter } from '../prompt-adapters.js';

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

export const emailAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ runtimeInfo }) => {
    const channelId = trimValue(runtimeInfo?.channelId);

    const hints = [
      '- Email replies should stay readable in plain text first and free of Discord-specific syntax. Simple emphasis, bullets, and inline code are fine; outbound email is sent as multipart text + HTML.',
      '- For normal email replies, append a polished corporate signature block derived from the identity details already loaded from `IDENTITY.md`. Prefer full name, role, organization, and any real contact details that are present. Do not invent contact info, and do not use emoji or mascot-style sign-offs.',
      '- Supported `message` actions here: `read` (ingested thread history for the current peer or an explicit email address) and `send` (reply or start a new outbound thread).',
      '- For a new outbound email thread, start the message body with `[Subject: Your subject here]` on its own line.',
      '- For replies in the current email thread, omit the subject prefix; the runtime keeps `Re:` subject continuity and threading headers automatically.',
      '- For `message` `read`, omit `channelId` to inspect the current email thread, or pass an explicit email address like `user@example.com`.',
      '- Email `read` only covers threads already ingested by the gateway; it does not do arbitrary mailbox-wide unread searches.',
      '- Email `message` sends use a plain email address like `user@example.com` as the target.',
      '- For catch-up or summary requests with incomplete scope, make a reasonable best-effort assumption, do the useful work first, and mention the assumption after the answer instead of blocking on a clarification.',
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
