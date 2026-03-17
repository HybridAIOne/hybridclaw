import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import type { SkillFeedbackSentiment } from '../../skills/adaptive-skills-types.js';
import { buildSessionIdFromContext } from './inbound.js';

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

export function resolveDiscordSkillFeedbackSessionId(input: {
  agentId?: string;
  guildId: string | null;
  channelId: string;
  userId: string;
}): string {
  return buildSessionIdFromContext(
    input.agentId || DEFAULT_AGENT_ID,
    input.guildId,
    input.channelId,
    input.userId,
  );
}
