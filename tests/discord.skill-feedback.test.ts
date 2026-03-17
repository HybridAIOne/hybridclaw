import { expect, test } from 'vitest';
import {
  classifyDiscordSkillFeedbackSentiment,
  formatDiscordSkillFeedbackMessage,
  resolveDiscordSkillFeedbackSessionId,
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

test('uses the reacting user session for DM skill feedback', () => {
  expect(
    resolveDiscordSkillFeedbackSessionId({
      guildId: null,
      channelId: 'dm-channel',
      userId: 'user-123',
    }),
  ).toBe('agent:main:channel:discord:chat:dm:peer:user-123');
});

test('uses the shared guild channel session for guild skill feedback', () => {
  expect(
    resolveDiscordSkillFeedbackSessionId({
      guildId: 'guild-123',
      channelId: 'channel-456',
      userId: 'user-123',
    }),
  ).toBe('agent:main:channel:discord:chat:channel:peer:channel-456');
});
