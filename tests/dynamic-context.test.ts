import { expect, test } from 'vitest';

import {
  DYNAMIC_CONTEXT_MESSAGE_PREFIX,
  isDynamicContextMessageText,
} from '../container/shared/dynamic-context.js';
import { buildDynamicContextMessage } from '../src/agent/conversation.js';
import { readDynamicContextMessage } from '../src/gateway/gateway-service.js';

test('dynamic context builder and detectors share one stable contract', () => {
  const message = buildDynamicContextMessage(
    new Date('2026-07-20T12:00:00.000Z'),
  );

  expect(message.content).toEqual(
    expect.stringContaining(`${DYNAMIC_CONTEXT_MESSAGE_PREFIX}2026-07-20`),
  );
  expect(isDynamicContextMessageText(message.content)).toBe(true);
});

test('does not identify generic context-tagged user text as generated context', () => {
  expect(isDynamicContextMessageText('<context>user-provided text</context>'))
    .toBe(false);
  expect(
    isDynamicContextMessageText(
      '<context>\nDate (UTC): 2026-07-20\nmissing closing tag',
    ),
  ).toBe(false);
});

test('gateway logging ignores generic context-tagged user messages', () => {
  const generated = '<context>\nDate (UTC): 2026-07-20\n</context>';

  expect(
    readDynamicContextMessage([
      { role: 'user', content: '<context>pasted XML-like text</context>' },
      { role: 'assistant', content: 'response' },
      { role: 'user', content: generated },
    ]),
  ).toBe(generated);
});
