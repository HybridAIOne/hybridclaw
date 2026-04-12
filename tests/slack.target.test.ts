import { expect, test } from 'vitest';

import {
  buildSlackChannelTarget,
  normalizeSlackChannelId,
  parseSlackChannelTarget,
} from '../src/channels/slack/target.ts';

test('accepts Slack DM channel ids when normalizing and building targets', () => {
  expect(normalizeSlackChannelId('D1234567890')).toBe('D1234567890');
  expect(buildSlackChannelTarget('D1234567890')).toBe('slack:D1234567890');
  expect(parseSlackChannelTarget('slack:D1234567890')).toEqual({
    target: 'slack:D1234567890',
    channelId: 'D1234567890',
    threadTs: null,
  });
});
