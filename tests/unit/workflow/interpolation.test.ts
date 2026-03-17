import { expect, test } from 'vitest';

import {
  buildWorkflowInterpolationContext,
  interpolateWorkflowTemplate,
} from '../../../src/workflow/interpolation.js';

test('interpolates trigger fields, extracted values, and prior step results', () => {
  const values = buildWorkflowInterpolationContext({
    event: {
      kind: 'message',
      sourceChannel: 'discord',
      channelId: '123',
      senderId: 'user-1',
      content: 'Please summarize the latest updates.',
      timestamp: Date.UTC(2026, 2, 16, 9, 0, 0),
    },
    workflowContext: {
      topic: 'release notes',
    },
    extractedValues: {
      digest_title: 'Daily Digest',
    },
    stepResults: [
      {
        index: 1,
        id: 'collect',
        result: 'Step one result',
      },
    ],
  });

  expect(
    interpolateWorkflowTemplate(
      'Title: {{digest_title}} | Source: {{trigger.sourceChannel}} | Body: {{step_1.result}} | Topic: {{topic}}',
      values,
    ),
  ).toBe(
    'Title: Daily Digest | Source: discord | Body: Step one result | Topic: release notes',
  );
});

test('renders missing variables as empty strings', () => {
  expect(
    interpolateWorkflowTemplate('Hello {{unknown}} world', {
      known: 'value',
    }),
  ).toBe('Hello  world');
});

test('falls back to the provided timestamp when no event exists', () => {
  const values = buildWorkflowInterpolationContext({
    fallbackTimestamp: '2026-03-16T09:30:00.000Z',
  });

  expect(values['trigger.timestamp']).toBe('2026-03-16T09:30:00.000Z');
});
