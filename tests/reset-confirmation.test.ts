import { expect, test } from 'vitest';

import {
  buildResetConfirmationComponents,
  buildResetConfirmationCustomId,
  parseResetConfirmationCustomId,
} from '../src/gateway/reset-confirmation.js';

test('buildResetConfirmationCustomId encodes session ids and parse reverses it', () => {
  const customId = buildResetConfirmationCustomId({
    action: 'yes',
    userId: '345678901234567890',
    sessionId: 'dm:439508376087560193',
  });

  expect(customId).toBe('reset:yes:345678901234567890:dm%3A439508376087560193');
  expect(parseResetConfirmationCustomId(customId)).toEqual({
    action: 'yes',
    userId: '345678901234567890',
    sessionId: 'dm:439508376087560193',
  });
});

test('buildResetConfirmationComponents creates the expected button rows', () => {
  expect(
    buildResetConfirmationComponents({
      userId: '345678901234567890',
      sessionId: 'session-reset',
    }),
  ).toEqual([
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          label: 'Reset Session',
          custom_id: 'reset:yes:345678901234567890:session-reset',
        },
        {
          type: 2,
          style: 2,
          label: 'Cancel',
          custom_id: 'reset:no:345678901234567890:session-reset',
        },
      ],
    },
  ]);
});
