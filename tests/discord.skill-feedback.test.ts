import { expect, test } from 'vitest';
import {
  classifyDiscordSkillFeedbackSentiment,
  formatDiscordSkillFeedbackMessage,
} from '../src/channels/discord/skill-feedback.ts';

test('classifies positive and negative Discord reactions for AdaptiveSkills feedback', () => {
  expect(classifyDiscordSkillFeedbackSentiment('👎')).toBe('negative');
  expect(classifyDiscordSkillFeedbackSentiment('👍')).toBe('positive');
  expect(classifyDiscordSkillFeedbackSentiment('❤️')).toBe('positive');
  expect(classifyDiscordSkillFeedbackSentiment('😂')).toBeNull();
});

test('formats Discord feedback notes consistently', () => {
  expect(
    formatDiscordSkillFeedbackMessage({
      emojiName: '👍',
      username: 'bea',
      messageId: '123',
    }),
  ).toBe('bea reacted with 👍 to assistant message 123.');
});
