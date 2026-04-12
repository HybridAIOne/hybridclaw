import { expect, test } from 'vitest';

import {
  buildConciergeChoiceComponents,
  buildConciergeChoiceCustomId,
  parseConciergeChoiceCustomId,
} from '../src/gateway/concierge-choice.js';

test('buildConciergeChoiceCustomId encodes session ids and parse reverses it', () => {
  const customId = buildConciergeChoiceCustomId({
    profile: 'no_hurry',
    userId: '345678901234567890',
    sessionId: 'dm:439508376087560193',
  });

  expect(customId).toBe(
    'concierge:no_hurry:345678901234567890:dm%3A439508376087560193',
  );
  expect(parseConciergeChoiceCustomId(customId)).toEqual({
    profile: 'no_hurry',
    userId: '345678901234567890',
    sessionId: 'dm:439508376087560193',
  });
});

test('buildConciergeChoiceComponents creates the expected button row', () => {
  expect(
    buildConciergeChoiceComponents({
      userId: '345678901234567890',
      sessionId: 'session-concierge',
    }),
  ).toEqual([
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: 'As soon as possible',
          custom_id: 'concierge:asap:345678901234567890:session-concierge',
        },
        {
          type: 2,
          style: 1,
          label: 'Can wait a bit',
          custom_id: 'concierge:balanced:345678901234567890:session-concierge',
        },
        {
          type: 2,
          style: 2,
          label: 'No hurry',
          custom_id: 'concierge:no_hurry:345678901234567890:session-concierge',
        },
      ],
    },
  ]);
});
