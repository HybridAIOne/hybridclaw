import type { SkillFeedbackSentiment } from '../../skills/adaptive-skills-types.js';

const NEGATIVE_SKILL_FEEDBACK_REACTIONS = new Set(['👎']);
const POSITIVE_SKILL_FEEDBACK_REACTIONS = new Set(['👍', '❤️', '❤']);

export function classifyDiscordSkillFeedbackSentiment(
  emojiName: string | null | undefined,
): Extract<SkillFeedbackSentiment, 'positive' | 'negative'> | null {
  const normalized = String(emojiName || '').trim();
  if (!normalized) return null;
  if (NEGATIVE_SKILL_FEEDBACK_REACTIONS.has(normalized)) {
    return 'negative';
  }
  if (POSITIVE_SKILL_FEEDBACK_REACTIONS.has(normalized)) {
    return 'positive';
  }
  return null;
}

export function formatDiscordSkillFeedbackMessage(input: {
  emojiName: string;
  username: string;
  messageId: string;
}): string {
  return `${input.username} reacted with ${input.emojiName} to assistant message ${input.messageId}.`;
}
